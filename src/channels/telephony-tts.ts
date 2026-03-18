// telephony-tts.ts — ElevenLabs multi-context WebSocket TTS for phone calls
// One persistent WebSocket per call. Each turn creates a lightweight "context"
// within that connection — no handshake overhead between turns.
// On barge-in, the current context is closed and a new one is opened instantly.
// Falls back to per-turn WebSocket if multi-context connection is unavailable.

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

// --- Multi-context persistent connection (one per call) ---

interface ContextState {
  onAudioChunk: (base64Audio: string) => void;
  onDone: () => void;
  cancelled: boolean;
  flushed: boolean;
  doneFired: boolean;
}

export class TtsConnection {
  private ws: WebSocket;
  private config: TtsConfig;
  private ready = false;
  private closed = false;
  private contextCounter = 0;
  private pendingMessages: string[] = [];
  private contexts = new Map<string, ContextState>();

  constructor(config: TtsConfig) {
    this.config = config;
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${config.voiceId}/multi-stream-input?model_id=${config.modelId}&output_format=ulaw_8000&auto_mode=true`;
    this.ws = new WebSocket(url, {
      headers: { "xi-api-key": config.apiKey },
    });

    this.ws.on("open", () => {
      if (this.closed) { this.ws.close(); return; }
      this.ready = true;
      for (const msg of this.pendingMessages) {
        this.ws.send(msg);
      }
      this.pendingMessages = [];
    });

    this.ws.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.error("[tts] Malformed WebSocket message, ignoring");
        return;
      }

      const ctx = msg.context_id ? this.contexts.get(msg.context_id) : null;
      if (!ctx || ctx.cancelled) return;

      if (msg.audio) {
        ctx.onAudioChunk(msg.audio);
      }
      // Only honor isFinal after flush — server sends isFinal for init space " " too
      if (msg.isFinal && ctx.flushed) {
        this.fireDone(msg.context_id);
      }
    });

    this.ws.on("error", (err) => {
      if (!this.closed) {
        console.error("[tts] WebSocket error:", err.message);
      }
      this.fireAllDone();
    });

    this.ws.on("close", () => {
      this.fireAllDone();
      this.ready = false;
    });
  }

  private fireDone(contextId: string) {
    const ctx = this.contexts.get(contextId);
    if (ctx && !ctx.doneFired && !ctx.cancelled) {
      ctx.doneFired = true;
      ctx.onDone();
    }
    this.contexts.delete(contextId);
  }

  private fireAllDone() {
    for (const [id, ctx] of this.contexts) {
      if (!ctx.doneFired && !ctx.cancelled) {
        ctx.doneFired = true;
        ctx.onDone();
      }
    }
    this.contexts.clear();
  }

  private send(msg: any) {
    const str = JSON.stringify(msg);
    if (this.ready && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(str);
    } else if (!this.closed) {
      this.pendingMessages.push(str);
    }
  }

  /** Create a new audio generation context within this connection. */
  createContext(
    onAudioChunk: (base64Audio: string) => void,
    onDone: () => void,
  ): TtsSession {
    const contextId = `ctx-${++this.contextCounter}`;
    const ctx: ContextState = {
      onAudioChunk,
      onDone,
      cancelled: false,
      flushed: false,
      doneFired: false,
    };
    this.contexts.set(contextId, ctx);

    // Initialize context with voice settings
    this.send({
      context_id: contextId,
      text: " ",
      voice_settings: {
        stability: 0.65,
        similarity_boost: 0.8,
        style: 0,
        speed: 1.0,
        use_speaker_boost: true,
      },
    });

    let buffer = "";
    let flushed = false;
    let cancelled = false;
    const send = this.send.bind(this);

    return {
      pushToken(token: string) {
        if (cancelled || flushed) return;
        buffer += token;

        if (SENTENCE_END.test(buffer)) {
          const text = buffer;
          buffer = "";
          send({ context_id: contextId, text, flush: true });
          return;
        }

        // Send token immediately, let the server buffer
        buffer = "";
        send({ context_id: contextId, text: token });
      },

      flush() {
        if (cancelled || flushed) return;
        flushed = true;
        ctx.flushed = true;
        if (buffer.trim()) {
          const text = buffer;
          buffer = "";
          send({ context_id: contextId, text, flush: true });
        }
        // Signal end of text for this context
        send({ context_id: contextId, text: "" });
      },

      cancel() {
        if (cancelled) return;
        cancelled = true;
        ctx.cancelled = true;
        ctx.doneFired = true; // don't fire onDone for cancelled contexts
        buffer = "";
        // Force close context immediately — server stops generating
        send({ context_id: contextId, close_context: true });
      },
    };
  }

  get isAlive(): boolean {
    return this.ready && !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  close() {
    this.closed = true;
    for (const [, ctx] of this.contexts) {
      ctx.cancelled = true;
      ctx.doneFired = true;
    }
    this.contexts.clear();
    if (this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ close_socket: true })); } catch {}
    }
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}

// --- Fallback: per-turn WebSocket (used if multi-context connection is down) ---

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

  const url = `wss://api.elevenlabs.io/v1/text-to-speech/${config.voiceId}/stream-input?model_id=${config.modelId}&output_format=ulaw_8000&auto_mode=true`;
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

    ws.send(JSON.stringify({
      text: " ",
      voice_settings: {
        stability: 0.65,
        similarity_boost: 0.8,
        style: 0,
        speed: 1.0,
        use_speaker_boost: true,
      },
    }));

    ready = true;

    for (const token of pendingTokens) {
      sendToken(token.text, token.flush);
    }
    pendingTokens.length = 0;

    if (flushed) {
      closeStream();
    }
  });

  ws.on("message", (data) => {
    if (cancelled) return;
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.error("[tts] Malformed WebSocket message, ignoring");
      return;
    }
    if (msg.audio) {
      onAudioChunk(msg.audio);
    } else if (msg.isFinal && flushed) {
      fireDone();
    }
  });

  ws.on("error", (err) => {
    if (!cancelled) {
      console.error("[tts] WebSocket error:", err.message);
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
