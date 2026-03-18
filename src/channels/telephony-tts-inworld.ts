// telephony-tts-inworld.ts — Inworld WebSocket streaming TTS for phone calls
// Uses the Inworld bidirectional WebSocket context protocol:
//   create context → send_text (per token) → close_context
// Tokens are sent immediately as they arrive from the LLM.
// flush_context at sentence boundaries forces immediate synthesis.
// Requests MULAW 8kHz audio so output is ready for Twilio without transcoding.

// @ts-ignore — ws default export works at runtime with tsx
import WebSocket from "ws";
import type { TtsSession } from "./telephony-tts.js";
import { SentenceDetector } from "./sentence-detector.js";

export interface InworldTtsConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
}


const WS_URL = "wss://api.inworld.ai/tts/v1/voice:streamBidirectional";

let contextCounter = 0;

export function createInworldTtsSession(
  config: InworldTtsConfig,
  onAudioChunk: (base64Audio: string) => void,
  onDone: () => void,
): TtsSession {
  let cancelled = false;
  let doneFired = false;
  let ready = false;
  let flushed = false;
  const detector = new SentenceDetector();
  const contextId = `ctx-${++contextCounter}`;
  const pendingTokens: { text: string; flush?: boolean }[] = [];

  const ws = new WebSocket(WS_URL, {
    headers: { Authorization: `Basic ${config.apiKey}` },
  });

  function fireDone() {
    if (!doneFired && !cancelled) {
      doneFired = true;
      onDone();
    }
  }

  function sendCreateContext() {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      context_id: contextId,
      create: {
        voice_id: config.voiceId,
        model_id: config.modelId,
        audio_config: {
          audio_encoding: "MULAW",
          sample_rate_hertz: 8000,
        },
      },
    }));
  }

  function sendText(text: string, flush?: boolean) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const msg: any = {
      context_id: contextId,
      send_text: { text },
    };
    if (flush) msg.send_text.flush_context = {};
    ws.send(JSON.stringify(msg));
  }

  function closeContext() {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      context_id: contextId,
      close_context: {},
    }));
  }

  ws.on("open", () => {
    if (cancelled) { ws.close(); return; }

    sendCreateContext();
    ready = true;

    for (const token of pendingTokens) {
      sendText(token.text, token.flush);
    }
    pendingTokens.length = 0;

    if (flushed) {
      closeContext();
    }
  });

  ws.on("message", (data) => {
    if (cancelled) return;
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.error("[tts-inworld] Malformed WebSocket message, ignoring");
      return;
    }

    if (msg.error) {
      console.error("[tts-inworld] Server error:", msg.error.message || msg.error);
      fireDone();
      return;
    }

    const result = msg.result;
    if (!result) {
      if (msg.done) fireDone();
      return;
    }

    if (result.contextClosed) {
      fireDone();
      return;
    }

    if (result.audioChunk) {
      const b64 = result.audioChunk.audioContent || result.audioContent;
      if (b64) {
        onAudioChunk(b64);
      }
    }
  });

  ws.on("error", (err) => {
    if (!cancelled) {
      console.error("[tts-inworld] WebSocket error:", err.message);
    }
    fireDone();
  });

  ws.on("close", () => {
    fireDone();
  });

  return {
    pushToken(token: string) {
      if (cancelled || flushed) return;
      for (const chunk of detector.feed(token)) {
        if (!ready) {
          pendingTokens.push({ text: chunk.text, flush: chunk.flush || undefined });
        } else {
          sendText(chunk.text, chunk.flush || undefined);
        }
      }
    },

    flush() {
      if (cancelled || flushed) return;
      flushed = true;
      const remaining = detector.drain();
      if (remaining) {
        if (ready) {
          sendText(remaining.text, true);
        } else {
          pendingTokens.push({ text: remaining.text, flush: true });
        }
      }
      if (ready) {
        closeContext();
      }
    },

    cancel() {
      cancelled = true;
      detector.reset();
      pendingTokens.length = 0;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
  };
}
