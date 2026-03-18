// telephony-tts-inworld.ts — Inworld WebSocket streaming TTS for phone calls
// Uses the Inworld bidirectional WebSocket context protocol:
//   create context → send_text (at sentence boundaries) → close_context
// Requests MULAW 8kHz audio so output is ready for Twilio without transcoding.

// @ts-ignore — ws default export works at runtime with tsx
import WebSocket from "ws";
import type { TtsSession } from "./telephony-tts.js";


export interface InworldTtsConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
}

const SENTENCE_END = /[.!?]\s*$/;
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
  let buffer = "";
  const contextId = `ctx-${++contextCounter}`;
  const pendingTexts: string[] = [];

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
          // MULAW at 8kHz matches Twilio's native format — no transcoding needed.
          // If Inworld doesn't support MULAW, switch to LINEAR16 and add conversion.
          audio_encoding: "MULAW",
          sample_rate_hertz: 8000,
        },
      },
    }));
  }

  function sendText(text: string) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      context_id: contextId,
      send_text: {
        text,
        flush_context: {},
      },
    }));
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

    // Flush any text that arrived before the connection was ready
    for (const text of pendingTexts) {
      sendText(text);
    }
    pendingTexts.length = 0;

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

    // Audio chunk — extract base64 content
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
      buffer += token;

      // Inworld works best with complete sentences — buffer tokens
      // and send at sentence boundaries for immediate synthesis
      if (SENTENCE_END.test(buffer)) {
        const text = buffer;
        buffer = "";
        if (!ready) {
          pendingTexts.push(text);
        } else {
          sendText(text);
        }
      }
      // Otherwise keep buffering (don't send individual tokens)
    },

    flush() {
      if (cancelled || flushed) return;
      flushed = true;
      if (buffer.trim()) {
        const text = buffer;
        buffer = "";
        if (ready) {
          sendText(text);
        } else {
          pendingTexts.push(text);
        }
      }
      if (ready) {
        closeContext();
      }
    },

    cancel() {
      cancelled = true;
      buffer = "";
      pendingTexts.length = 0;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
  };
}
