// telephony-asr.ts — ElevenLabs streaming speech-to-text for phone calls
// Uses ScribeRealtime with ULAW_8000 format (matches Twilio's audio exactly).
// VAD (Voice Activity Detection) automatically detects when the caller stops speaking
// and emits committed transcripts.
// Buffers audio chunks until the WebSocket is fully open.

import {
  ElevenLabsClient,
  RealtimeEvents,
  AudioFormat,
  CommitStrategy,
  type RealtimeConnection,
} from "@elevenlabs/elevenlabs-js";

export interface AsrCallbacks {
  onPartialTranscript: (text: string) => void;    // interim results as caller speaks
  onFinalTranscript: (text: string) => void;       // complete utterance after silence
  onError: (error: string) => void;
}

export interface AsrSession {
  connection: RealtimeConnection;
  feedAudio: (base64Payload: string) => void;      // feed Twilio's base64 mulaw chunks
  close: () => void;
}

// Create a streaming ASR session using ElevenLabs ScribeRealtime.
// Twilio sends audio as base64 mulaw 8kHz — ElevenLabs accepts this natively.
export async function createAsrSession(
  apiKey: string,
  language: string,
  callbacks: AsrCallbacks,
): Promise<AsrSession> {
  const client = new ElevenLabsClient({ apiKey });

  // Track whether the WebSocket is ready to receive audio
  let ready = false;
  let closed = false;
  const pendingChunks: string[] = [];

  const connection = await client.speechToText.realtime.connect({
    modelId: "scribe_v2_realtime",
    audioFormat: AudioFormat.ULAW_8000,
    sampleRate: 8000,
    commitStrategy: CommitStrategy.VAD,
    vadSilenceThresholdSecs: 1.5,
    vadThreshold: 0.5,
    minSpeechDurationMs: 200,
    minSilenceDurationMs: 500,
    languageCode: language,
  });

  // Keepalive ping every 15s to prevent idle timeout on long tool executions
  const keepaliveTimer = setInterval(() => {
    try {
      const ws = (connection as any).websocket;
      if (ws && ws.readyState === 1) ws.ping();
    } catch { /* ignore */ }
  }, 15_000);

  connection.on(RealtimeEvents.OPEN, () => {
    console.log("[asr] WebSocket open");
  });

  connection.on(RealtimeEvents.SESSION_STARTED, () => {
    console.log("[asr] Session started — flushing buffered audio");
    ready = true;
    // Flush any audio that arrived before the connection was ready
    for (const chunk of pendingChunks) {
      connection.send({ audioBase64: chunk });
    }
    pendingChunks.length = 0;
  });

  connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (data) => {
    if (data.text) {
      callbacks.onPartialTranscript(data.text);
    }
  });

  // Deduplicate — VAD can sometimes commit the same utterance twice
  let lastTranscript = "";
  connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (data) => {
    if (data.text && data.text !== lastTranscript) {
      lastTranscript = data.text;
      console.log(`[asr] Transcript: "${data.text}"`);
      callbacks.onFinalTranscript(data.text);
    }
  });

  connection.on(RealtimeEvents.ERROR, (error) => {
    const message = error instanceof Error ? error.message : (error as any).error ?? "Unknown error";
    console.error(`[asr] Error: ${message}`);
    callbacks.onError(message);
  });

  connection.on(RealtimeEvents.CLOSE, () => {
    ready = false;
    closed = true;
    clearInterval(keepaliveTimer);
    console.log("[asr] Connection closed");
  });

  return {
    connection,
    feedAudio(base64Payload: string) {
      if (closed) return;
      if (!ready) {
        // Buffer until the session is ready
        pendingChunks.push(base64Payload);
        return;
      }
      connection.send({ audioBase64: base64Payload });
    },
    close() {
      closed = true;
      ready = false;
      clearInterval(keepaliveTimer);
      pendingChunks.length = 0;
      connection.close();
    },
  };
}
