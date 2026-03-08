// cli.ts — CLI REPL for interactive agent sessions

import { createInterface } from "readline";
import { startAgent } from "./agent.js";
import { attachLogger } from "./logger.js";
import type { Model } from "@mariozechner/pi-ai";

export async function startCli(options: {
  model: Model<"openai-completions">;
  apiKey: string;
  cwd: string;
}): Promise<void> {
  const { model, apiKey, cwd } = options;

  console.log(`Type your message. Ctrl+C to exit.\n`);

  const session = await startAgent({
    model,
    apiKey,
    cwd,
    resumeSession: false,
  });

  attachLogger(session);

  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\n> ",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    try {
      await session.prompt(input);
      console.log();
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\nGoodbye.");
    process.exit(0);
  });
}
