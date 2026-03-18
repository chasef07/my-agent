// audio-pipeline.ts — STT→LLM→TTS streaming, barge-in, fillers, and timing
// The core logic that makes phone calls feel natural.
// Uses an explicit state machine (listening → processing → speaking → listening)
// instead of a boolean lock to manage turn transitions.

import type { TelephonyConfig } from "../config.js";
import { createTtsSession } from "./telephony-tts.js";
import { createInworldTtsSession } from "./telephony-tts-inworld.js";
import type { TtsSession } from "./telephony-tts.js";
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

// ASR annotations like (static), (noise), (music) — not real speech
const ASR_ANNOTATION = /^\s*\(.*\)\s*$/;

/** True if text contains at least one non-filler word and isn't an ASR annotation. */
export function hasRealWords(text: string): boolean {
  if (ASR_ANNOTATION.test(text)) return false;
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  return words.some((w) => !FILLERS.has(w));
}

/** Count non-filler words. Used for barge-in threshold (require 2+ words to interrupt). */
function countRealWords(text: string): number {
  if (ASR_ANNOTATION.test(text)) return 0;
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  return words.filter((w) => !FILLERS.has(w)).length;
}

function createTts(
  session: CallSession,
  config: TelephonyConfig,
  onAudioChunk: (base64Audio: string) => void,
  onDone: () => void,
): TtsSession {
  if (config.ttsProvider === "inworld") {
    const iw = config.inworld;
    if (!iw) throw new Error("ttsProvider is 'inworld' but inworld config is missing");
    return createInworldTtsSession(
      { apiKey: iw.apiKey, voiceId: iw.voiceId, modelId: iw.modelId },
      onAudioChunk,
      onDone,
    );
  }
  // Use multi-context connection if available (no handshake per turn)
  if (session.ttsConnection?.isAlive) {
    return session.ttsConnection.createContext(onAudioChunk, onDone);
  }
  // Fallback to per-turn WebSocket
  return createTtsSession(
    { apiKey: config.elevenlabs.apiKey, voiceId: config.elevenlabs.voiceId, modelId: config.elevenlabs.modelId },
    onAudioChunk,
    onDone,
  );
}

// Create ASR callbacks wired to barge-in + utterance handling
export function createAsrCallbacks(session: CallSession, config: TelephonyConfig): AsrCallbacks {
  return {
    onPartialTranscript(text) {
      process.stdout.write(`\r${dim("  [hearing]")} "${text}"          `);
      if (session.state === "speaking" && session.tts && countRealWords(text) >= 2) {
        process.stdout.write("\n");
        console.log(yellow("  [asr barge-in]") + " (fallback) Caller interrupted — cancelling TTS");
        session.transport.clearAudio(session.streamSid);
        session.tts.cancel();
        session.tts = null;
        session.state = "listening";
        session.vad?.reset();
        session.bargeIn?.reset();
      }
    },
    onFinalTranscript(text) {
      process.stdout.write("\r");
      if (!hasRealWords(text)) {
        console.log(dim(`  [filler] "${text}"`));
        return;
      }
      if (session.state !== "listening") {
        console.log(dim(`  [dropped] "${text}" (state=${session.state})`));
        return;
      }
      console.log(green("  [caller]") + ` "${text}"`);
      session.state = "processing";
      session.turnCount++;
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
    session.state = "speaking";
    session.vad?.reset();
    session.bargeIn?.reset();
    const greeting = createTts(
      session,
      config,
      (base64Audio) => session.transport.sendAudio(session.streamSid, base64Audio),
      () => {
        console.log(dim("  [greeting] Done"));
        if (session.state === "speaking") {
          session.transport.sendMark(session.streamSid, "greeting-done");
        }
      },
    );
    session.tts = greeting;
    greeting.pushToken("Welcome to Abita Eye Care, how can I help you today?");
    greeting.flush();
  } catch (err) {
    console.error(red("[error]") + ` Greeting TTS failed:`, err);
    session.state = "listening";
  }
}

// The core streaming loop for one utterance
export async function processUtterance(
  session: CallSession,
  text: string,
  config: TelephonyConfig,
): Promise<void> {
  if (!session.agentSession || session.state !== "processing") return;

  const thisTurn = session.turnCount;

  // Cancel any in-progress TTS
  if (session.tts) {
    session.tts.cancel();
    session.tts = null;
    session.transport.clearAudio(session.streamSid);
  }
  session.vad?.reset();
  session.bargeIn?.reset();

  const llmStart = Date.now();
  let firstTokenAt = 0;
  let firstTtsAt = 0;

  const tts = createTts(
    session,
    config,
    (base64Audio) => {
      if (session.turnCount !== thisTurn) return;
      if (!firstTtsAt) {
        firstTtsAt = Date.now();
        console.log(dim(`  [latency] First audio: ${ms(llmStart)}`));
      }
      if (session.state === "processing") {
        session.state = "speaking";
      }
      session.transport.sendAudio(session.streamSid, base64Audio);
    },
    () => {
      if (session.turnCount !== thisTurn) return;
      console.log(dim(`  [turn ${thisTurn}] Complete in ${ms(llmStart)}`));
      if (session.state === "speaking") {
        // Don't transition immediately — send a mark and wait for Twilio
        // to confirm the caller has actually heard the audio
        session.transport.sendMark(session.streamSid, `turn-${thisTurn}-done`);
      }
    },
  );
  session.tts = tts;

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
    const totalMs = Date.now() - llmStart;
    session.logger.logTurn(
      thisTurn,
      text,
      agentText,
      firstTokenAt ? firstTokenAt - llmStart : 0,
      firstTtsAt ? firstTtsAt - llmStart : 0,
      totalMs,
    );
    // Only reset if this is still the current turn and no TTS audio was produced
    // (if TTS produced audio, the done callback handles the transition)
    if (session.turnCount === thisTurn && session.state === "processing") {
      session.state = "listening";
    }
  }
}
