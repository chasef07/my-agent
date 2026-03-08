// server.ts — Fastify HTTP/WebSocket server for telephony
// Pure server concerns. Only file that knows about Fastify.

import Fastify, { type FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import { execFile } from "child_process";
import { promisify } from "util";
import { glob } from "glob";
import type { TelephonyConfig } from "./config.js";
import type { AgentOptions } from "./agent.js";
import { TwilioTransport } from "./channels/twilio-transport.js";
import { CallSession } from "./channels/call-session.js";

const execFileAsync = promisify(execFile);

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const activeCalls = new Map<string, CallSession>();

async function runWarmScripts() {
  const warmScripts = await glob("workspace/skills/*/warm.sh");
  if (!warmScripts.length) return { scripts: 0, failed: 0 };
  const results = await Promise.allSettled(
    warmScripts.map((script) => execFileAsync(script)),
  );
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed) console.log(dim(`[pre-call] ${failed}/${warmScripts.length} warm scripts failed`));
  return { scripts: warmScripts.length, failed };
}

export async function startServer(options: {
  config: TelephonyConfig;
  agentOptions: AgentOptions;
}): Promise<FastifyInstance> {
  const { config, agentOptions } = options;
  const server = Fastify({ logger: false });
  await server.register(websocketPlugin);

  server.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  // --- POST /voice ---
  server.post("/voice", async (request, reply) => {
    const host = request.headers.host;
    const wsProtocol = host?.includes("localhost") ? "ws" : "wss";

    // Fire-and-forget: warm skills while Twilio processes the TwiML
    runWarmScripts().catch(() => {});

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsProtocol}://${host}/media-stream" />
  </Connect>
</Response>`;

    reply.type("text/xml").send(twiml);
    console.log(cyan("[call]") + " Incoming call — TwiML sent");
  });

  // --- GET /media-stream ---
  server.get("/media-stream", { websocket: true }, (socket) => {
    let currentSession: CallSession | null = null;

    const transport = new TwilioTransport(socket);

    transport.onStart((streamSid, callSid) => {
      const session = new CallSession(callSid, streamSid, transport);
      activeCalls.set(streamSid, session);
      currentSession = session;
      console.log(cyan("[call]") + ` Connected — ${dim(callSid.slice(0, 10) + "...")}`);
      session.initialize(config, agentOptions);
    });

    transport.onMedia((payload) => {
      if (currentSession?.asr) {
        currentSession.asr.feedAudio(payload);
      }
    });

    transport.onStop(() => {
      if (currentSession) {
        currentSession.cleanup();
        activeCalls.delete(currentSession.streamSid);
        currentSession = null;
      }
    });

    transport.onClose(() => {
      if (currentSession) {
        currentSession.cleanup();
        activeCalls.delete(currentSession.streamSid);
        currentSession = null;
      }
    });

    transport.onError((err) => {
      console.error(red("[error]") + ` WebSocket: ${err.message}`);
    });
  });

  // --- POST /pre-call --- skill warming webhook (also called automatically from /voice)
  server.post("/pre-call", async () => {
    const result = await runWarmScripts();
    return { status: "ok", ...result };
  });

  // --- Health check ---
  server.get("/health", async () => ({ status: "ok", activeCalls: activeCalls.size }));

  // Run warm scripts once at startup (amd auth, etc.) so the token is cached
  // before any calls come in. Per-call warming is redundant but harmless.
  await runWarmScripts().catch(() => {});

  const port = config.port;
  await server.listen({ port, host: "0.0.0.0" });

  console.log("");
  console.log(cyan("═══ Telephony Server ═══"));
  console.log(`  Port:    ${port}`);
  console.log(`  Webhook: http://localhost:${port}/voice`);
  console.log(`  Health:  http://localhost:${port}/health`);
  console.log(`  Voice:   ${config.elevenlabs.voiceId}`);
  console.log(`  Model:   ${config.elevenlabs.modelId}`);
  console.log(cyan("════════════════════════"));
  console.log("");

  return server;
}
