// index.ts — Entrypoint: load config, pick mode, delegate

import { loadConfig, getApiKey, createModel } from "./config.js";
import { startServer } from "./server.js";
import { startCli } from "./cli.js";

const config = loadConfig();
const apiKey = getApiKey(config);
const model = createModel(config);
const agentOptions = { model, apiKey, cwd: process.cwd() };

console.log(`my-agent v0.1.0`);
console.log(`Model: ${model.provider}/${model.id}`);

if (config.telephony?.enabled) {
  await startServer({ config: config.telephony, agentOptions });
}

if (process.stdin.isTTY) {
  await startCli({ model, apiKey, cwd: process.cwd() });
} else if (!config.telephony?.enabled) {
  console.error("No TTY and telephony not enabled. Nothing to do.");
  process.exit(1);
}
