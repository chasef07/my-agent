// telephony-tts.ts — ElevenLabs WebSocket streaming TTS for phone calls
// Streams LLM tokens directly to ElevenLabs over a persistent WebSocket.
// Sends flush:true at sentence boundaries to force immediate audio generation.
// Audio arrives as base64 ulaw_8000 ready for Twilio.

// @ts-ignore — ws default export works at runtime with tsx
import WebSocket from "ws";

export interface TtsConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
}

export interface TtsSession {
  pushToken: (token: string) => void;
  flush: () => void;
  cancel: () => void;
}

// Sentence-ending punctuation — triggers flush:true to force immediate audio generation
const SENTENCE_END = /[.!?]\s*$/;

export function createTtsSession(
  config: TtsConfig,
  onAudioChunk: (base64Audio: string) => void,
  onDone: () => void,
): TtsSession {
  let cancelled = false;
  let doneFired = false;
  let ready = false;
  let flushed = false;
  let buffer = "";
  const pendingTokens: { text: string; flush?: boolean }[] = [];

  const url = `wss://api.elevenlabs.io/v1/text-to-speech/${config.voiceId}/stream-input?model_id=${config.modelId}&output_format=ulaw_8000`;
  const ws = new WebSocket(url, {
    headers: { "xi-api-key": config.apiKey },
  });

  function fireDone() {
    if (!doneFired && !cancelled) {
      doneFired = true;
      onDone();
    }
  }

  function closeStream() {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ text: "" }));
    }
  }

  function sendToken(text: string, flush?: boolean) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const msg: { text: string; flush?: boolean } = { text };
    if (flush) msg.flush = true;
    ws.send(JSON.stringify(msg));
  }

  ws.on("open", () => {
    if (cancelled) { ws.close(); return; }

    // Init message: voice settings + chunking config
    ws.send(JSON.stringify({
      text: " ",
      voice_settings: {
        stability: 0.48,
        similarity_boost: 0.8,
        style: 0,
        speed: 1.0,
        use_speaker_boost: false,
      },
      generation_config: {
        chunk_length_schedule: [50, 100, 200, 260],
      },
    }));

    ready = true;

    // Flush any tokens that arrived before the connection was ready
    for (const token of pendingTokens) {
      sendToken(token.text, token.flush);
    }
    pendingTokens.length = 0;

    // If flush() was called before we connected, close the stream now
    if (flushed) {
      closeStream();
    }
  });

  ws.on("message", (data) => {
    if (cancelled) return;
    const msg = JSON.parse(data.toString());
    if (msg.audio) {
      onAudioChunk(msg.audio);
    } else if (msg.isFinal && flushed) {
      // Only honor isFinal after flush() — the server sends isFinal for the
      // init space " " too, which would close the session prematurely.
      fireDone();
    }
  });

  ws.on("error", (err) => {
    if (!cancelled) {
      console.error("[tts] WebSocket error:", err.message);
    }
  });

  ws.on("close", () => {
    // If we already flushed, this is the expected close — signal done.
    // If not flushed, this is an unexpected close (error/timeout) — still signal done
    // so the turn doesn't hang forever.
    fireDone();
  });

  return {
    pushToken(token: string) {
      if (cancelled || flushed) return;
      buffer += token;

      // Check if the accumulated buffer ends at a sentence boundary
      if (SENTENCE_END.test(buffer)) {
        const text = buffer;
        buffer = "";
        if (!ready) {
          pendingTokens.push({ text, flush: true });
        } else {
          sendToken(text, true);
        }
        return;
      }

      // Otherwise send the token immediately, let the server buffer
      buffer = "";
      if (!ready) {
        pendingTokens.push({ text: token });
      } else {
        sendToken(token);
      }
    },

    flush() {
      if (cancelled || flushed) return;
      flushed = true;
      // Send any remaining buffered text with flush
      if (buffer.trim()) {
        const text = buffer;
        buffer = "";
        if (ready) {
          sendToken(text, true);
        } else {
          pendingTokens.push({ text, flush: true });
        }
      }
      if (ready) {
        closeStream();
      }
      // If not ready yet, closeStream will be called after open + pending flush
    },

    cancel() {
      cancelled = true;
      buffer = "";
      pendingTokens.length = 0;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
  };
}
