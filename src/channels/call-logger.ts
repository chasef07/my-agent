// call-logger.ts — Lightweight per-call observability
// Subscribes to agent events and writes structured JSON logs.

import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

const LOG_DIR = join(import.meta.dirname, "..", "..", "logs");
mkdirSync(LOG_DIR, { recursive: true });

interface ToolCallLog {
  name: string;
  args: any;
  result?: any;
  isError: boolean;
  startedAt: number;
  durationMs: number;
}

interface TurnLog {
  turn: number;
  callerText: string;
  agentText: string;
  firstTokenMs: number;
  firstAudioMs: number;
  totalMs: number;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    totalTokens: number;
  };
  toolCalls: ToolCallLog[];
}

interface CallLog {
  callSid: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  totalTurns: number;
  turns: TurnLog[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    cacheHitRate: number;
    toolCalls: number;
    toolErrors: number;
    avgFirstTokenMs: number;
    avgFirstAudioMs: number;
  };
}

export class CallLogger {
  private callSid: string;
  private startedAt: Date;
  private turns: TurnLog[] = [];
  private pendingTools = new Map<string, { name: string; args: any; startedAt: number }>();
  private currentTurnTools: ToolCallLog[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(callSid: string) {
    this.callSid = callSid;
    this.startedAt = new Date();
  }

  /** Subscribe to agent events for token usage and tool call tracking */
  attach(agentSession: AgentSession): void {
    this.unsubscribe = agentSession.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        this.pendingTools.set(event.toolCallId, {
          name: event.toolName,
          args: event.args,
          startedAt: Date.now(),
        });
      }

      if (event.type === "tool_execution_end") {
        const pending = this.pendingTools.get(event.toolCallId);
        this.pendingTools.delete(event.toolCallId);
        this.currentTurnTools.push({
          name: event.toolName,
          args: pending?.args,
          result: event.isError ? event.result : undefined,
          isError: event.isError,
          startedAt: pending?.startedAt ?? Date.now(),
          durationMs: pending ? Date.now() - pending.startedAt : 0,
        });
      }

      // Capture token usage from completed LLM responses
      if (event.type === "message_end" && "role" in event.message && event.message.role === "assistant") {
        const msg = event.message as { usage?: { input: number; output: number; cacheRead: number; totalTokens: number } };
        if (msg.usage) {
          this._lastUsage = msg.usage;
        }
      }
    });
  }

  private _lastUsage: { input: number; output: number; cacheRead: number; totalTokens: number } | null = null;

  /** Call after each turn completes to record metrics */
  logTurn(turn: number, callerText: string, agentText: string, firstTokenMs: number, firstAudioMs: number, totalMs: number): void {
    this.turns.push({
      turn,
      callerText,
      agentText: agentText.slice(0, 200),
      firstTokenMs,
      firstAudioMs,
      totalMs,
      usage: this._lastUsage ?? { input: 0, output: 0, cacheRead: 0, totalTokens: 0 },
      toolCalls: [...this.currentTurnTools],
    });
    this._lastUsage = null;
    this.currentTurnTools = [];
  }

  /** Write the final call log to disk */
  flush(): void {
    if (this.unsubscribe) this.unsubscribe();

    const endedAt = new Date();
    const durationSec = (endedAt.getTime() - this.startedAt.getTime()) / 1000;

    const inputTokens = this.turns.reduce((s, t) => s + t.usage.input, 0);
    const outputTokens = this.turns.reduce((s, t) => s + t.usage.output, 0);
    const cacheReadTokens = this.turns.reduce((s, t) => s + t.usage.cacheRead, 0);
    const totalTokens = this.turns.reduce((s, t) => s + t.usage.totalTokens, 0);
    const toolCalls = this.turns.reduce((s, t) => s + t.toolCalls.length, 0);
    const toolErrors = this.turns.reduce((s, t) => s + t.toolCalls.filter((tc) => tc.isError).length, 0);
    const turnsWithFirstToken = this.turns.filter((t) => t.firstTokenMs > 0);
    const turnsWithFirstAudio = this.turns.filter((t) => t.firstAudioMs > 0);

    const log: CallLog = {
      callSid: this.callSid,
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationSec: Math.round(durationSec * 10) / 10,
      totalTurns: this.turns.length,
      turns: this.turns,
      totals: {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        totalTokens,
        cacheHitRate: inputTokens + cacheReadTokens > 0
          ? Math.round((cacheReadTokens / (inputTokens + cacheReadTokens)) * 1000) / 1000
          : 0,
        toolCalls,
        toolErrors,
        avgFirstTokenMs: turnsWithFirstToken.length
          ? Math.round(turnsWithFirstToken.reduce((s, t) => s + t.firstTokenMs, 0) / turnsWithFirstToken.length)
          : 0,
        avgFirstAudioMs: turnsWithFirstAudio.length
          ? Math.round(turnsWithFirstAudio.reduce((s, t) => s + t.firstAudioMs, 0) / turnsWithFirstAudio.length)
          : 0,
      },
    };

    const date = this.startedAt.toISOString().slice(0, 10);
    const logPath = join(LOG_DIR, `calls-${date}.jsonl`);
    appendFileSync(logPath, JSON.stringify(log) + "\n");

    // Print summary to stdout so it shows up in Railway logs
    console.log(`\n[call-log] ${this.callSid} — ${log.durationSec}s, ${log.totalTurns} turns`);
    console.log(`  tokens: ${log.totals.inputTokens} in / ${log.totals.outputTokens} out / ${log.totals.cacheReadTokens} cache-read (${log.totals.totalTokens} total)`);
    console.log(`  cache hit rate: ${(log.totals.cacheHitRate * 100).toFixed(1)}%`);
    console.log(`  tools: ${log.totals.toolCalls} calls, ${log.totals.toolErrors} errors`);
    console.log(`  avg latency: ${log.totals.avgFirstTokenMs}ms first-token, ${log.totals.avgFirstAudioMs}ms first-audio`);
    for (const turn of log.turns) {
      const toolInfo = turn.toolCalls.length ? ` | tools: ${turn.toolCalls.map(tc => `${tc.name}(${tc.durationMs}ms${tc.isError ? " ERR" : ""})`).join(", ")}` : "";
      console.log(`  turn ${turn.turn}: ${turn.firstTokenMs}ms tok, ${turn.firstAudioMs}ms audio, ${turn.totalMs}ms total | "${turn.callerText.slice(0, 50)}"${toolInfo}`);
    }
    console.log(`[call-log] full JSON: ${JSON.stringify(log)}\n`);
  }
}
