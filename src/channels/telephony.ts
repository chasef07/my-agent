// telephony.ts — Twilio Media Streams server
// Full pipeline: Caller audio → ASR → Agent → TTS → Caller hears response
//
// Endpoints:
//   POST /voice        — Twilio webhook, returns TwiML to open a media stream
//   GET  /media-stream — WebSocket for bidirectional audio with Twilio
//
// Each call gets its own agent session, ASR session, and TTS session.

import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
import type { WebSocket } from "ws";
import type { TelephonyConfig } from "../config.js";
import { createAsrSession, type AsrSession } from "./telephony-asr.js";
import { createTtsSession, type TtsSession } from "./telephony-tts.js";
import { startAgent, type AgentOptions } from "../agent.js";

import type { AgentSession } from "@mariozechner/pi-coding-agent";

// --- Timing helpers ---
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function ms(start: number): string {
  return `${(Date.now() - start)}ms`;
}

// Twilio WebSocket event types
interface TwilioStartEvent {
  event: "start";
  start: {
    streamSid: string;
    callSid: string;
    accountSid: string;
    mediaFormat: { encoding: string; sampleRate: number; channels: number };
  };
}

interface TwilioMediaEvent {
  event: "media";
  media: {
    payload: string;
    timestamp: string;
    chunk: string;
  };
}

interface TwilioStopEvent {
  event: "stop";
  stop: { accountSid: string; callSid: string };
}

type TwilioEvent =
  | { event: "connected" }
  | TwilioStartEvent
  | TwilioMediaEvent
  | TwilioStopEvent;

// Tracks an active phone call with all its components
interface ActiveCall {
  callSid: string;
  streamSid: string;
  startedAt: Date;
  socket: WebSocket;
  asr: AsrSession | null;
  tts: TtsSession | null;
  agentSession: AgentSession | null;
  processing: boolean;
  turnCount: number;
}

const activeCalls = new Map<string, ActiveCall>();

function ttsConfigFrom(config: TelephonyConfig) {
  return {
    apiKey: config.elevenlabs.apiKey,
    voiceId: config.elevenlabs.voiceId,
    modelId: config.elevenlabs.modelId,
  };
}

// Filler phrases spoken during tool calls to prevent dead air
const TOOL_FILLERS = [
  "one moment.",
  "let me check on that.",
  "sure, one second.",
  "let me pull that up.",
];

// Filler words that shouldn't trigger the agent or barge-in
const FILLERS = new Set(["um", "uh", "uhh", "umm", "hmm", "hm", "ah", "oh", "er", "like", "so", "well", "actually"]);

function hasRealWords(text: string): boolean {
  // Keep digits so phone numbers, dates, etc. aren't stripped to empty
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  return words.some((w) => !FILLERS.has(w));
}

export interface TelephonyServerOptions {
  config: TelephonyConfig;
  agentOptions: AgentOptions;
}

export async function startTelephonyServer(options: TelephonyServerOptions) {
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
    let currentCall: ActiveCall | null = null;

    socket.on("message", (data: Buffer) => {
      const event: TwilioEvent = JSON.parse(data.toString());

      switch (event.event) {
        case "connected":
          break;

        case "start": {
          const { streamSid, callSid } = event.start;
          const call: ActiveCall = {
            callSid,
            streamSid,
            startedAt: new Date(),
            socket,
            asr: null,
            tts: null,
            agentSession: null,
            processing: false,
            turnCount: 0,
          };
          activeCalls.set(streamSid, call);
          currentCall = call;
          console.log(cyan("[call]") + ` Connected — ${dim(callSid.slice(0, 10) + "...")}`);
          initializeCall(call, config, agentOptions);
          break;
        }

        case "media": {
          if (currentCall?.asr) {
            currentCall.asr.feedAudio(event.media.payload);
          }
          break;
        }

        case "stop": {
          if (currentCall) {
            cleanupCall(currentCall);
            activeCalls.delete(currentCall.streamSid);
            currentCall = null;
          }
          break;
        }
      }
    });

    socket.on("close", () => {
      if (currentCall) {
        cleanupCall(currentCall);
        activeCalls.delete(currentCall.streamSid);
        currentCall = null;
      }
    });

    socket.on("error", (err: Error) => {
      console.error(red("[error]") + ` WebSocket: ${err.message}`);
    });
  });

  // --- Health check ---
  server.get("/health", async () => ({ status: "ok", activeCalls: activeCalls.size }));

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

// Initialize all components for a new call
async function initializeCall(
  call: ActiveCall,
  config: TelephonyConfig,
  agentOptions: AgentOptions,
) {
  const initStart = Date.now();

  // 1. Agent session
  try {
    const session = await startAgent({ ...agentOptions, resumeSession: false });
    call.agentSession = session;
    // Attach tool call logging for this session
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        const preview = JSON.stringify(event.args);
        const short = preview.length > 80 ? preview.slice(0, 80) + "..." : preview;
        console.log(yellow("  [tool]") + ` ${event.toolName} ${dim(short)}`);
      }
      if (event.type === "tool_execution_end") {
        const status = event.isError ? red("✗") : green("✓");
        const result = String(event.result ?? "");
        const preview = result.length > 200 ? result.slice(0, 200) + "..." : result;
        console.log(yellow("  [tool]") + ` ${event.toolName} ${status} ${dim(preview)}`);
      }
    });
  } catch (err) {
    console.error(red("[error]") + ` Agent init failed:`, err);
    return;
  }

  // 2. ASR session
  try {
    const asr = await createAsrSession(config.elevenlabs.apiKey, config.asr.language, {
      onPartialTranscript(text) {
        process.stdout.write(`\r${dim("  [hearing]")} "${text}"          `);
        if (call.processing && call.tts && hasRealWords(text)) {
          process.stdout.write("\n");
          console.log(yellow("  [barge-in]") + " Caller interrupted — cancelling TTS");
          call.tts.cancel();
          call.tts = null;
          clearTwilioAudio(call.socket, call.streamSid);
        }
      },
      onFinalTranscript(text) {
        process.stdout.write("\r");
        if (!hasRealWords(text)) {
          console.log(dim(`  [filler] "${text}"`));
          return;
        }
        console.log(green("  [caller]") + ` "${text}"`);
        handleCallerUtterance(call, text, config);
      },
      onError(error) {
        console.error(red("  [asr error]") + ` ${error}`);
      },
    });
    call.asr = asr;
  } catch (err) {
    console.error(red("[error]") + ` ASR init failed:`, err);
  }

  console.log(dim(`  [init] Ready in ${ms(initStart)}`));

  // Greet the caller immediately in the agent's voice
  try {
    const greeting = createTtsSession(
      ttsConfigFrom(config),
      (base64Audio) => sendAudioToTwilio(call.socket, call.streamSid, base64Audio),
      () => console.log(dim("  [greeting] Done")),
    );
    call.tts = greeting;
    greeting.pushToken("Welcome to Abita Eye Care, how can I help you today?");
    greeting.flush();
  } catch (err) {
    console.error(red("[error]") + ` Greeting TTS failed:`, err);
  }
}

// Handle a complete utterance from the caller
async function handleCallerUtterance(
  call: ActiveCall,
  text: string,
  config: TelephonyConfig,
) {
  if (!call.agentSession) return;

  // Cancel any in-progress TTS
  if (call.tts) {
    call.tts.cancel();
    call.tts = null;
    clearTwilioAudio(call.socket, call.streamSid);
  }

  // Pre-warm TTS WebSocket — connects while we wait for the processing lock
  let llmStart = Date.now();
  let firstTokenAt = 0;
  let firstTtsAt = 0;
  let turn = 0;

  const tts = createTtsSession(
    ttsConfigFrom(config),
    (base64Audio) => {
      if (!firstTtsAt) {
        firstTtsAt = Date.now();
        console.log(dim(`  [latency] First audio: ${ms(llmStart)}`));
      }
      sendAudioToTwilio(call.socket, call.streamSid, base64Audio);
    },
    () => {
      const total = ms(llmStart);
      console.log(dim(`  [turn ${turn}] Complete in ${total}`));
    },
  );
  call.tts = tts;

  while (call.processing) {
    await new Promise((r) => setTimeout(r, 100));
  }
  call.processing = true;
  call.turnCount++;
  turn = call.turnCount;

  // Reset timing after lock acquired
  llmStart = Date.now();
  let agentText = "";
  let fillerSent = false;

  // Subscribe to agent streaming
  const unsubscribe = call.agentSession.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      if (!firstTokenAt) {
        firstTokenAt = Date.now();
        console.log(dim(`  [latency] First token: ${ms(llmStart)}`));
      }
      agentText += event.assistantMessageEvent.delta;
      tts.pushToken(event.assistantMessageEvent.delta);
    }

    // Inject filler audio when a tool call starts and the LLM hasn't said anything yet
    if (event.type === "tool_execution_start" && !fillerSent && !agentText.trim()) {
      fillerSent = true;
      const filler = TOOL_FILLERS[Math.floor(Math.random() * TOOL_FILLERS.length)];
      console.log(dim(`  [filler] "${filler}"`));
      tts.pushToken(filler);
    }
  });

  try {
    await call.agentSession.prompt(text);
    tts.flush();
    // Log what the agent said (truncate long responses)
    const preview = agentText.length > 120 ? agentText.slice(0, 120) + "..." : agentText;
    console.log(cyan("  [agent]") + ` "${preview.replace(/\n/g, " ")}"`);
  } catch (err) {
    console.error(red("  [agent error]") + ` ${err instanceof Error ? err.message : err}`);
  } finally {
    unsubscribe();
    call.processing = false;
  }
}

function cleanupCall(call: ActiveCall) {
  const duration = ((Date.now() - call.startedAt.getTime()) / 1000).toFixed(1);
  if (call.asr) call.asr.close();
  if (call.tts) call.tts.cancel();
  console.log(cyan("[call]") + ` Ended — ${call.turnCount} turns, ${duration}s`);
}

function sendAudioToTwilio(socket: WebSocket, streamSid: string, payload: string) {
  socket.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
}

function clearTwilioAudio(socket: WebSocket, streamSid: string) {
  socket.send(JSON.stringify({ event: "clear", streamSid }));
}
