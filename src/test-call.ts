// test-call.ts — Make a test call to your Twilio number
// Usage: npx tsx src/test-call.ts +1YOURNUMBER
// This tells Twilio to call your personal phone, which then connects to the agent.

import twilio from "twilio";
import { loadConfig } from "./config.js";

const config = loadConfig();
if (!config.telephony) {
  console.error("Telephony not configured in config.json");
  process.exit(1);
}

const to = process.argv[2];
if (!to) {
  console.error("Usage: npx tsx src/test-call.ts +1YOURNUMBER");
  console.error("  Calls your personal phone, which connects to the agent via Twilio.");
  process.exit(1);
}

const { accountSid, authToken, phoneNumber } = config.telephony.twilio;
const client = twilio(accountSid, authToken);

async function main() {
  console.log(`Calling ${to} from ${phoneNumber}...`);
  console.log("When you pick up, you'll be connected to the agent.\n");

  const call = await client.calls.create({
    to,
    from: phoneNumber,
    url: `https://${process.env.NGROK_URL || "YOUR_NGROK_URL"}/voice`,
  });

  console.log(`Call SID: ${call.sid}`);
  console.log("Waiting for call to complete...\n");

  // Poll call status
  const poll = setInterval(async () => {
    const status = await client.calls(call.sid).fetch();
    if (["completed", "failed", "busy", "no-answer", "canceled"].includes(status.status)) {
      console.log(`\nCall ${status.status} — duration: ${status.duration}s`);
      clearInterval(poll);
    }
  }, 3000);
}

main().catch(console.error);
