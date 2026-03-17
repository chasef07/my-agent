// server.ts — Fastify HTTP/WebSocket server for telephony
// Pure server concerns. Only file that knows about Fastify.

import Fastify, { type FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import { fileURLToPath } from "url";
import path from "path";
import type { TelephonyConfig } from "./config.js";
import type { AgentOptions } from "./agent.js";
import { TwilioTransport } from "./channels/twilio-transport.js";
import { CallSession } from "./channels/call-session.js";
import { initVad, cleanupVad } from "./channels/silero-vad.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const activeCalls = new Map<string, CallSession>();

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

    function cleanupSession() {
      if (currentSession) {
        try {
          currentSession.cleanup();
        } catch (err) {
          console.error(red("[error]") + ` Cleanup failed: ${err instanceof Error ? err.message : err}`);
        }
        activeCalls.delete(currentSession.streamSid);
        currentSession = null;
      }
    }

    const transport = new TwilioTransport(socket);

    transport.onStart((streamSid, callSid) => {
      const session = new CallSession(callSid, streamSid, transport);
      activeCalls.set(streamSid, session);
      currentSession = session;
      console.log(cyan("[call]") + ` Connected — ${dim(callSid.slice(0, 10) + "...")}`);
      session.initialize(config, agentOptions).catch((err) => {
        console.error(red("[error]") + ` Call init failed: ${err instanceof Error ? err.message : err}`);
        cleanupSession();
      });
    });

    transport.onMedia((payload) => {
      try {
        if (currentSession?.asr) {
          currentSession.asr.feedAudio(payload);
        }
      } catch (err) {
        console.error(red("[error]") + ` Audio feed failed: ${err instanceof Error ? err.message : err}`);
      }
      // Local VAD for fast barge-in detection
      if (currentSession?.vad && currentSession?.bargeIn) {
        currentSession.vad.processChunk(payload).then((prob) => {
          if (prob !== null && currentSession?.bargeIn) {
            currentSession.bargeIn.onVadResult(prob, currentSession.state);
          }
        }).catch((err) => {
          console.error(red("[error]") + ` VAD inference failed: ${err instanceof Error ? err.message : err}`);
        });
      }
    });

    transport.onMark((name) => {
      if (currentSession && currentSession.state === "speaking") {
        currentSession.state = "listening";
      }
    });

    transport.onStop(() => cleanupSession());
    transport.onClose(() => cleanupSession());

    transport.onError((err) => {
      console.error(red("[error]") + ` WebSocket: ${err.message}`);
      cleanupSession();
    });
  });

  // --- Health check ---
  server.get("/health", async () => ({ status: "ok", activeCalls: activeCalls.size }));

  // Preload Silero VAD model so inference is instant on first call
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  await initVad(path.join(__dirname, "..", "models", "silero_vad.onnx"));

  const port = config.port;
  await server.listen({ port, host: "0.0.0.0" });

  // --- Graceful shutdown ---
  // On kill signal: stop accepting new calls, wait for active calls to finish, then exit.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${cyan("[server]")} ${signal} received — shutting down gracefully`);

    // Stop accepting new connections
    await server.close();

    // Wait for active calls to drain (check every second, max 30s)
    const maxWait = 30_000;
    const start = Date.now();
    while (activeCalls.size > 0 && Date.now() - start < maxWait) {
      console.log(dim(`  [shutdown] Waiting for ${activeCalls.size} active call(s)...`));
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (activeCalls.size > 0) {
      console.log(red(`  [shutdown] Force-closing ${activeCalls.size} remaining call(s)`));
      for (const session of activeCalls.values()) {
        try { session.cleanup(); } catch {}
      }
      activeCalls.clear();
    }

    await cleanupVad();
    console.log(cyan("[server]") + " Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

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
