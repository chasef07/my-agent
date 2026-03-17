import { loadConfig, getApiKey, createModel } from "../src/config.js";
import { startAgent } from "../src/agent.js";

async function main() {
  const config = loadConfig();
  const model = createModel(config);
  const apiKey = getApiKey(config);
  const session = await startAgent({ model, apiKey, cwd: process.cwd(), resumeSession: false });

  let text = "";
  session.subscribe((e: any) => {
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      text += e.assistantMessageEvent.delta;
    }
    if (e.type === "tool_execution_end") {
      const r = typeof e.result === "string" ? e.result : JSON.stringify(e.result);
      console.log("TOOL:", e.toolName, r.slice(0, 800));
    }
  });

  await session.prompt('Run this exact command in bash: which amd && amd --help');
  console.log("\nAGENT:", text.slice(0, 500));
  process.exit(0);
}

main();
