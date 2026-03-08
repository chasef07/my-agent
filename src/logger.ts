// logger.ts — Debug logging for agent events
// Remove the attachLogger() call in index.ts to disable all logging.

import type { AgentSession } from "@mariozechner/pi-coding-agent";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

// Track timing for latency measurements
const timers = new Map<string, number>();

function elapsed(key: string): string {
  const start = timers.get(key);
  if (!start) return "";
  timers.delete(key);
  return dim(`(${((Date.now() - start) / 1000).toFixed(1)}s)`);
}

export function attachLogger(session: AgentSession): void {
  session.subscribe((event) => {
    switch (event.type) {
      case "turn_start":
        timers.set("turn", Date.now());
        break;

      case "turn_end":
        console.error(dim(`\n--- turn complete ${elapsed("turn")} ---`));
        break;

      case "tool_execution_start": {
        timers.set(`tool:${event.toolCallId}`, Date.now());
        const input = JSON.stringify(event.args);
        const preview = input.length > 120 ? input.slice(0, 120) + "..." : input;
        console.error(yellow(`[tool:start] ${event.toolName}`) + dim(` ${preview}`));
        break;
      }

      case "tool_execution_end": {
        const time = elapsed(`tool:${event.toolCallId}`);
        const status = event.isError ? " (error)" : "";
        console.error(green(`[tool:done]  ${event.toolName}`) + `${status} ${time}`);
        break;
      }
    }
  });
}
