// eval/runner.ts — Run a scripted conversation through the agent in text mode

import { startAgent, type AgentOptions } from "../src/agent.js";
import type { Scenario, ConversationTurn, ConversationResult, ToolCallRecord } from "./types.js";

const TURN_TIMEOUT = 30_000;

export async function runConversation(
  agentOptions: AgentOptions,
  scenario: Scenario,
  maxTurns: number,
): Promise<ConversationResult> {
  const session = await startAgent({ ...agentOptions, resumeSession: false });
  const turns: ConversationTurn[] = [];

  const script = scenario.callerScript.slice(0, maxTurns);

  for (const callerText of script) {
    let agentText = "";
    const toolCalls: ToolCallRecord[] = [];
    const pendingTools = new Map<string, { name: string; args: any; startedAt: number }>();

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        agentText += event.assistantMessageEvent.delta;
      }
      if (event.type === "tool_execution_start") {
        pendingTools.set(event.toolCallId, {
          name: event.toolName,
          args: event.args,
          startedAt: Date.now(),
        });
      }
      if (event.type === "tool_execution_end") {
        const pending = pendingTools.get(event.toolCallId);
        pendingTools.delete(event.toolCallId);
        const result = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
        toolCalls.push({
          name: event.toolName,
          args: pending?.args,
          result: result?.slice(0, 500),
          isError: event.isError,
          durationMs: pending ? Date.now() - pending.startedAt : 0,
        });
      }
    });

    try {
      await Promise.race([
        session.prompt(callerText),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Turn timed out")), TURN_TIMEOUT),
        ),
      ]);
    } catch (err) {
      agentText += ` [ERROR: ${err instanceof Error ? err.message : err}]`;
    }

    unsubscribe();

    turns.push({ role: "caller", text: callerText });
    turns.push({ role: "agent", text: agentText.trim(), toolCalls: toolCalls.length ? toolCalls : undefined });
  }

  // Build readable transcript
  const transcript = turns.map((t) => {
    let line = `[${t.role}] ${t.text}`;
    if (t.toolCalls?.length) {
      const tools = t.toolCalls.map((tc) =>
        `  [tool:${tc.name}] ${tc.isError ? "ERROR" : "ok"} (${tc.durationMs}ms)`,
      );
      line += "\n" + tools.join("\n");
    }
    return line;
  }).join("\n");

  return { scenario, turns, transcript };
}
