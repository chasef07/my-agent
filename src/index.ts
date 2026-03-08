// index.ts — CLI entrypoint
// This is the main loop: load config, start the agent, read user input, stream responses.
// Run with: BASETEN_API_KEY=... npm run dev

import { createInterface } from "readline";
import { loadConfig, getApiKey, createModel } from "./config.js";
import { startAgent } from "./agent.js";
import { attachLogger } from "./logger.js"; // Remove this line to disable debug logging

import { startTelephonyServer } from "./channels/telephony.js";

// 1. Load config.json and resolve the API key from the environment
const config = loadConfig();
const apiKey = getApiKey(config);
const model = createModel(config);

// Agent options shared between CLI and telephony
const agentOptions = { model, apiKey, cwd: process.cwd() };

// Start telephony server if enabled — each call gets its own agent session
if (config.telephony?.enabled) {
  startTelephonyServer({ config: config.telephony, agentOptions }).catch((err) => {
    console.error("[telephony] Failed to start:", err.message);
  });
}

console.log(`my-agent v0.1.0`);
console.log(`Model: ${model.provider}/${model.id}`);

// In telephony-only mode (no TTY), just keep the process alive for the server
if (!process.stdin.isTTY && config.telephony?.enabled) {
  console.log("Running in telephony-only mode (no TTY)");
} else {
  console.log(`Type your message. Ctrl+C to exit.\n`);

  // Start the CLI agent session
  const session = await startAgent({
    model,
    apiKey,
    cwd: process.cwd(),
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
