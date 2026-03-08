// audio-pipeline.ts — STT→LLM→TTS streaming, barge-in, fillers, and timing
// The core logic that makes phone calls feel natural.

import type { TelephonyConfig } from "../config.js";
import { createTtsSession } from "./telephony-tts.js";
import type { TwilioTransport } from "./twilio-transport.js";
import type { CallSession } from "./call-session.js";
import type { AsrCallbacks } from "./telephony-asr.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function ms(start: number): string {
  return `${(Date.now() - start)}ms`;
}

// Filler words that shouldn't trigger the agent or barge-in
const FILLERS = new Set(["um", "uh", "uhh", "umm", "hmm", "hm", "ah", "oh", "er", "like", "so", "well", "actually"]);

export function hasRealWords(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  return words.some((w) => !FILLERS.has(w));
}

function ttsConfigFrom(config: TelephonyConfig) {
  return {
    apiKey: config.elevenlabs.apiKey,
    voiceId: config.elevenlabs.voiceId,
    modelId: config.elevenlabs.modelId,
  };
}

// Create ASR callbacks wired to barge-in + utterance handling
export function createAsrCallbacks(session: CallSession, config: TelephonyConfig): AsrCallbacks {
  return {
    onPartialTranscript(text) {
      process.stdout.write(`\r${dim("  [hearing]")} "${text}"          `);
      if (session.processing && session.tts && hasRealWords(text)) {
        process.stdout.write("\n");
        console.log(yellow("  [barge-in]") + " Caller interrupted — cancelling TTS");
        session.tts.cancel();
        session.tts = null;
        session.transport.clearAudio(session.streamSid);
      }
    },
    onFinalTranscript(text) {
      process.stdout.write("\r");
      if (!hasRealWords(text)) {
        console.log(dim(`  [filler] "${text}"`));
        return;
      }
      console.log(green("  [caller]") + ` "${text}"`);
      processUtterance(session, text, config);
    },
    onError(error) {
      console.error(red("  [asr error]") + ` ${error}`);
    },
  };
}

// Send a greeting via TTS
export function speakGreeting(session: CallSession, config: TelephonyConfig): void {
  try {
    const greeting = createTtsSession(
      ttsConfigFrom(config),
      (base64Audio) => session.transport.sendAudio(session.streamSid, base64Audio),
      () => console.log(dim("  [greeting] Done")),
    );
    session.tts = greeting;
    greeting.pushToken("Welcome to Abita Eye Care, how can I help you today?");
    greeting.flush();
  } catch (err) {
    console.error(red("[error]") + ` Greeting TTS failed:`, err);
  }
}

// The core streaming loop for one utterance
export async function processUtterance(
  session: CallSession,
  text: string,
  config: TelephonyConfig,
): Promise<void> {
  if (!session.agentSession) return;

  // Cancel any in-progress TTS
  if (session.tts) {
    session.tts.cancel();
    session.tts = null;
    session.transport.clearAudio(session.streamSid);
  }

  // Pre-warm TTS WebSocket
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
      session.transport.sendAudio(session.streamSid, base64Audio);
    },
    () => {
      const total = ms(llmStart);
      console.log(dim(`  [turn ${turn}] Complete in ${total}`));
    },
  );
  session.tts = tts;

  // Wait for processing lock
  while (session.processing) {
    await new Promise((r) => setTimeout(r, 100));
  }
  session.processing = true;
  session.turnCount++;
  turn = session.turnCount;

  // Reset timing after lock acquired
  llmStart = Date.now();
  let agentText = "";

  const unsubscribe = session.agentSession.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      if (!firstTokenAt) {
        firstTokenAt = Date.now();
        console.log(dim(`  [latency] First token: ${ms(llmStart)}`));
      }
      agentText += event.assistantMessageEvent.delta;
      tts.pushToken(event.assistantMessageEvent.delta);
    }
  });

  try {
    const TURN_TIMEOUT = 30_000;
    await Promise.race([
      session.agentSession.prompt(text),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Turn timed out after 30s")), TURN_TIMEOUT),
      ),
    ]);
    tts.flush();
    const preview = agentText.length > 120 ? agentText.slice(0, 120) + "..." : agentText;
    console.log(cyan("  [agent]") + ` "${preview.replace(/\n/g, " ")}"`);
  } catch (err) {
    console.error(red("  [agent error]") + ` ${err instanceof Error ? err.message : err}`);
    tts.pushToken("sorry, I'm having trouble right now. could you say that again?");
    tts.flush();
  } finally {
    unsubscribe();
    session.processing = false;
  }
}
