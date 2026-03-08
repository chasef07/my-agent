// tracing.ts — LangSmith observability for agent sessions
// Traces each conversation turn as a run with child spans for LLM, tools, and TTS.
//
// Setup: set these env vars:
//   LANGCHAIN_TRACING_V2=true
//   LANGCHAIN_API_KEY=ls_...
//   LANGCHAIN_PROJECT=my-agent   (optional, defaults to "default")
//
// Usage: attachTracing(session) — works for both CLI and telephony sessions.

import { RunTree } from "langsmith";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

const enabled = process.env.LANGCHAIN_TRACING_V2 === "true";

export function attachTracing(
  session: AgentSession,
  metadata?: Record<string, string>,
): () => void {
  if (!enabled) return () => {};

  let turnRun: RunTree | null = null;
  let toolRuns = new Map<string, RunTree>();
  let llmRun: RunTree | null = null;
  let agentText = "";

  return session.subscribe((event) => {
    switch (event.type) {
      case "turn_start": {
        agentText = "";
        turnRun = new RunTree({
          run_type: "chain",
          name: "agent-turn",
          inputs: {},
          extra: { metadata },
        });
        turnRun.postRun().catch(() => {});
        break;
      }

      case "message_update": {
        if (!turnRun) break;
        if (event.assistantMessageEvent.type === "text_delta") {
          // Create LLM child run on first token
          if (!llmRun) {
            llmRun = turnRun.createChild({
              run_type: "llm",
              name: "llm-generate",
              inputs: {},
            });
            llmRun.postRun().catch(() => {});
          }
          agentText += event.assistantMessageEvent.delta;
        }
        break;
      }

      case "tool_execution_start": {
        if (!turnRun) break;
        // End the LLM span before tool execution
        if (llmRun) {
          llmRun.end({ outputs: { text: agentText } });
          llmRun.patchRun().catch(() => {});
          llmRun = null;
        }
        const toolRun = turnRun.createChild({
          run_type: "tool",
          name: event.toolName,
          inputs: event.args as Record<string, unknown>,
        });
        toolRun.postRun().catch(() => {});
        toolRuns.set(event.toolCallId, toolRun);
        break;
      }

      case "tool_execution_end": {
        const toolRun = toolRuns.get(event.toolCallId);
        if (toolRun) {
          toolRun.end({
            outputs: { result: event.result },
            error: event.isError ? String(event.result) : undefined,
          });
          toolRun.patchRun().catch(() => {});
          toolRuns.delete(event.toolCallId);
        }
        break;
      }

      case "turn_end": {
        // Close any open LLM span
        if (llmRun) {
          llmRun.end({ outputs: { text: agentText } });
          llmRun.patchRun().catch(() => {});
          llmRun = null;
        }
        // Close the turn
        if (turnRun) {
          turnRun.end({ outputs: { response: agentText } });
          turnRun.patchRun().catch(() => {});
          turnRun = null;
        }
        toolRuns = new Map();
        agentText = "";
        break;
      }
    }
  });
}
