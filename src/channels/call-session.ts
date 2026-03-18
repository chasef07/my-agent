// call-session.ts — Per-call lifecycle (init, cleanup, state)
// One instance per phone call, self-contained.

import type { TelephonyConfig } from "../config.js";
import type { TwilioTransport } from "./twilio-transport.js";
import type { AgentOptions } from "../agent.js";
import { startAgent } from "../agent.js";
import { createAsrSession, type AsrSession } from "./telephony-asr.js";
import { createAsrCallbacks, speakGreeting } from "./audio-pipeline.js";
import { TtsConnection, type TtsSession } from "./telephony-tts.js";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { createVadState, type VadState } from "./silero-vad.js";
import { createBargeInDetector, type BargeInDetector } from "./barge-in.js";
import { CallLogger } from "./call-logger.js";

export type CallState = "listening" | "processing" | "speaking";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function ms(start: number): string {
  return `${(Date.now() - start)}ms`;
}

export class CallSession {
  callSid: string;
  streamSid: string;
  transport: TwilioTransport;
  agentSession: AgentSession | null = null;
  asr: AsrSession | null = null;
  tts: TtsSession | null = null;
  ttsConnection: TtsConnection | null = null;
  vad: VadState | null = null;
  bargeIn: BargeInDetector | null = null;
  logger: CallLogger;
  state: CallState = "listening";
  turnCount = 0;
  startedAt = new Date();

  constructor(
    callSid: string,
    streamSid: string,
    transport: TwilioTransport,
  ) {
    this.callSid = callSid;
    this.streamSid = streamSid;
    this.transport = transport;
    this.logger = new CallLogger(callSid);
  }

  async initialize(config: TelephonyConfig, agentOptions: AgentOptions): Promise<void> {
    const initStart = Date.now();

    // 1. Agent session
    try {
      const session = await startAgent({ ...agentOptions, resumeSession: false });
      this.agentSession = session;
      this.logger.attach(session);
      session.subscribe((event) => {
        if (event.type === "tool_execution_start") {
          const preview = JSON.stringify(event.args);
          const short = preview.length > 80 ? preview.slice(0, 80) + "..." : preview;
          console.log(yellow("  [tool]") + ` ${event.toolName} ${dim(short)}`);
        }
        if (event.type === "tool_execution_end") {
          const status = event.isError ? red("✗") : green("✓");
          const raw = event.result ?? "";
          const result = typeof raw === "string" ? raw : JSON.stringify(raw);
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
      const callbacks = createAsrCallbacks(this, config);
      const asr = await createAsrSession(config.elevenlabs.apiKey, config.asr.language, callbacks);
      this.asr = asr;
    } catch (err) {
      console.error(red("[error]") + ` ASR init failed:`, err);
    }

    // 3. Persistent TTS connection (multi-context — one WebSocket for the whole call)
    if (config.ttsProvider !== "inworld") {
      this.ttsConnection = new TtsConnection({
        apiKey: config.elevenlabs.apiKey,
        voiceId: config.elevenlabs.voiceId,
        modelId: config.elevenlabs.modelId,
      });
    }

    // 4. Local VAD for fast barge-in
    this.vad = createVadState();
    this.bargeIn = createBargeInDetector(() => {
      if (this.tts) { this.tts.cancel(); this.tts = null; }
      this.transport.clearAudio(this.streamSid);
      this.state = "listening";
      this.vad?.reset();
      this.bargeIn?.reset();
    });

    console.log(dim(`  [init] Ready in ${ms(initStart)}`));

    // 4. Greet the caller — short delay so Twilio finishes bridging the audio path
    await new Promise((r) => setTimeout(r, 750));
    speakGreeting(this, config);
  }

  cleanup(): void {
    const duration = ((Date.now() - this.startedAt.getTime()) / 1000).toFixed(1);
    if (this.asr) this.asr.close();
    if (this.tts) this.tts.cancel();
    if (this.ttsConnection) this.ttsConnection.close();
    this.vad = null;
    this.bargeIn = null;
    this.logger.flush();
    console.log(cyan("[call]") + ` Ended — ${this.turnCount} turns, ${duration}s`);
  }
}
