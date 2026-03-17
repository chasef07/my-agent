// call-logger.ts — Per-call observability
// Subscribes to agent events and writes structured JSON logs.
// Tracks: token usage, latencies, tool calls, compaction, retries, context window.

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

interface CompactionLog {
  reason: "threshold" | "overflow";
  tokensBefore: number;
  aborted: boolean;
  errorMessage?: string;
}

interface RetryLog {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
  success: boolean;
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
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
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
  compactions: CompactionLog[];
  retries: RetryLog[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    cacheHitRate: number;
    toolCalls: number;
    toolErrors: number;
    compactionCount: number;
    retryCount: number;
    peakContextPercent: number;
    avgFirstTokenMs: number;
    avgFirstAudioMs: number;
  };
}

export class CallLogger {
  private callSid: string;
  private startedAt: Date;
  private turns: TurnLog[] = [];
  private compactions: CompactionLog[] = [];
  private retries: RetryLog[] = [];
  private pendingTools = new Map<string, { name: string; args: any; startedAt: number }>();
  private currentTurnTools: ToolCallLog[] = [];
  private unsubscribe: (() => void) | null = null;
  private agentSession: AgentSession | null = null;
  private pendingCompaction: { reason: "threshold" | "overflow" } | null = null;
  private pendingRetry: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string } | null = null;

  constructor(callSid: string) {
    this.callSid = callSid;
    this.startedAt = new Date();
  }

  /** Subscribe to agent events for token usage, tool calls, compaction, and retries */
  attach(agentSession: AgentSession): void {
    this.agentSession = agentSession;
    this.unsubscribe = agentSession.subscribe((event) => {
      // Tool tracking
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

      // Token usage from completed LLM responses
      if (event.type === "message_end" && "role" in event.message && event.message.role === "assistant") {
        const msg = event.message as { usage?: { input: number; output: number; cacheRead: number; totalTokens: number } };
        if (msg.usage) {
          this._lastUsage = msg.usage;
        }
      }

      // Compaction tracking
      if (event.type === "auto_compaction_start") {
        this.pendingCompaction = { reason: event.reason };
        console.log(`  [compaction] Started (reason: ${event.reason})`);
      }

      if (event.type === "auto_compaction_end") {
        this.compactions.push({
          reason: this.pendingCompaction?.reason ?? "threshold",
          tokensBefore: event.result?.tokensBefore ?? 0,
          aborted: event.aborted,
          errorMessage: event.errorMessage,
        });
        this.pendingCompaction = null;
        if (event.aborted) {
          console.log(`  [compaction] Aborted${event.errorMessage ? `: ${event.errorMessage}` : ""}`);
        } else {
          console.log(`  [compaction] Complete — ${event.result?.tokensBefore ?? "?"} tokens before`);
        }
      }

      // Retry tracking
      if (event.type === "auto_retry_start") {
        this.pendingRetry = {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorMessage: event.errorMessage,
        };
        console.log(`  [retry] Attempt ${event.attempt}/${event.maxAttempts} (${event.errorMessage})`);
      }

      if (event.type === "auto_retry_end") {
        if (this.pendingRetry) {
          this.retries.push({
            ...this.pendingRetry,
            success: event.success,
          });
          this.pendingRetry = null;
        }
      }
    });
  }

  private _lastUsage: { input: number; output: number; cacheRead: number; totalTokens: number } | null = null;

  /** Call after each turn completes to record metrics */
  logTurn(turn: number, callerText: string, agentText: string, firstTokenMs: number, firstAudioMs: number, totalMs: number): void {
    // Snapshot context window usage at end of turn
    let contextUsage: TurnLog["contextUsage"];
    if (this.agentSession) {
      const cu = this.agentSession.getContextUsage();
      if (cu) {
        contextUsage = {
          tokens: cu.tokens,
          contextWindow: cu.contextWindow,
          percent: cu.percent,
        };
      }
    }

    this.turns.push({
      turn,
      callerText,
      agentText: agentText.slice(0, 200),
      firstTokenMs,
      firstAudioMs,
      totalMs,
      usage: this._lastUsage ?? { input: 0, output: 0, cacheRead: 0, totalTokens: 0 },
      contextUsage,
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
    const peakContextPercent = this.turns.reduce((max, t) => Math.max(max, t.contextUsage?.percent ?? 0), 0);

    const log: CallLog = {
      callSid: this.callSid,
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationSec: Math.round(durationSec * 10) / 10,
      totalTurns: this.turns.length,
      turns: this.turns,
      compactions: this.compactions,
      retries: this.retries,
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
        compactionCount: this.compactions.length,
        retryCount: this.retries.length,
        peakContextPercent: Math.round(peakContextPercent * 10) / 10,
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
    console.log(`  context: peak ${log.totals.peakContextPercent}% | compactions: ${log.totals.compactionCount} | retries: ${log.totals.retryCount}`);
    console.log(`  tools: ${log.totals.toolCalls} calls, ${log.totals.toolErrors} errors`);
    console.log(`  avg latency: ${log.totals.avgFirstTokenMs}ms first-token, ${log.totals.avgFirstAudioMs}ms first-audio`);
    for (const turn of log.turns) {
      const ctx = turn.contextUsage ? ` | ctx: ${turn.contextUsage.percent?.toFixed(1) ?? "?"}%` : "";
      const toolInfo = turn.toolCalls.length ? ` | tools: ${turn.toolCalls.map(tc => `${tc.name}(${tc.durationMs}ms${tc.isError ? " ERR" : ""})`).join(", ")}` : "";
      console.log(`  turn ${turn.turn}: ${turn.firstTokenMs}ms tok, ${turn.firstAudioMs}ms audio, ${turn.totalMs}ms total${ctx} | "${turn.callerText.slice(0, 50)}"${toolInfo}`);
    }
    console.log(`[call-log] full JSON: ${JSON.stringify(log)}\n`);
  }
}
