// index.ts — CLI entrypoint
// This is the main loop: load config, start the agent, read user input, stream responses.
// Run with: BASETEN_API_KEY=... npm run dev

import { createInterface } from "readline";
import { loadConfig, getApiKey, createModel } from "./config.js";
import { startAgent } from "./agent.js";
import { attachLogger } from "./logger.js"; // Remove this line to disable debug logging
import { attachTracing } from "./tracing.js";
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
console.log(`Type your message. Ctrl+C to exit.\n`);

// 2. Start the agent session — this connects to the LLM and sets up tools
const session = await startAgent({
  model,
  apiKey,
  cwd: process.cwd(),
  resumeSession: false,
});

// 3. Attach debug logger — shows tool calls and latency in stderr
// Remove this line to disable debug logging in production
attachLogger(session);
attachTracing(session, { channel: "cli" });

// 4. Subscribe to streaming events — print each text chunk as it arrives
// The agent streams tokens one by one. We listen for "text_delta" events
// and write them directly to stdout for a real-time typing effect.
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

// 4. Set up readline — simple terminal input loop
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "\n> ",
});

rl.prompt();

// Each line the user types gets sent to the agent as a prompt.
// session.prompt() sends the message to the LLM and waits for the
// full response (streaming happens via the subscriber above).
rl.on("line", async (line) => {
  const input = line.trim();
  if (!input) {
    rl.prompt();
    return;
  }

  try {
    await session.prompt(input);
    console.log(); // newline after the streamed response
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : err);
  }

  rl.prompt();
});

rl.on("close", () => {
  console.log("\nGoodbye.");
  process.exit(0);
});
