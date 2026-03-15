// silero-vad.ts — Local Silero VAD via ONNX for fast barge-in detection
// Shared ONNX session loaded once at startup; per-call VadState with own RNN hidden state.
// Context window implementation matches Together AI's reference:
// https://docs.together.ai/docs/how-to-build-phone-voice-agent

import * as ort from "onnxruntime-node";

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

// --- Standard G.711 mulaw decode table (byte → int16) ---
const MULAW_DECODE_TABLE = new Int16Array(256);
{
  for (let i = 0; i < 256; i++) {
    const byte = ~i & 0xff;
    const sign = byte & 0x80;
    const exponent = (byte >> 4) & 0x07;
    const mantissa = byte & 0x0f;
    let magnitude = ((mantissa << 3) + 0x84) << exponent;
    magnitude -= 0x84;
    MULAW_DECODE_TABLE[i] = sign ? -magnitude : magnitude;
  }
}

// --- Shared ONNX session ---
let sharedSession: ort.InferenceSession | null = null;

export async function initVad(modelPath: string): Promise<void> {
  sharedSession = await ort.InferenceSession.create(modelPath, {
    interOpNumThreads: 1,
    intraOpNumThreads: 1,
    executionProviders: ["cpu"],
  });
  console.log(cyan("[VAD]") + " Silero VAD model loaded");
}

// --- Per-call state ---
const SR = 8000; // Twilio mulaw sample rate
const WINDOW = 256; // 32ms at 8kHz — Silero's expected frame size
const CONTEXT = 32; // Context from previous frame, prepended to input

const STATE_SIZE = 2 * 1 * 128; // Silero v5 unified state: [2, 1, 128]

export class VadState {
  private rnnState: Float32Array;
  private context: Float32Array;
  private inputBuffer: Float32Array;
  private sampleRate: BigInt64Array;
  private sampleBuf: Float32Array;
  private sampleBufLen: number;
  private processingChain: Promise<void>;

  constructor() {
    this.rnnState = new Float32Array(STATE_SIZE);
    this.context = new Float32Array(CONTEXT);
    this.inputBuffer = new Float32Array(CONTEXT + WINDOW);
    this.sampleRate = BigInt64Array.from([BigInt(SR)]);
    this.sampleBuf = new Float32Array(WINDOW + 160); // window + typical Twilio chunk (20ms)
    this.sampleBufLen = 0;
    this.processingChain = Promise.resolve();
  }

  /** Decode mulaw base64 payload, accumulate samples, run inference when a full frame is ready.
   *  Returns speech probability 0-1 when a frame completes, null otherwise. */
  processChunk(base64Mulaw: string): Promise<number | null> {
    // Decode base64 → mulaw bytes → int16 PCM
    const raw = Buffer.from(base64Mulaw, "base64");

    // Chain processing to ensure ordered execution
    const resultPromise = new Promise<number | null>((resolve) => {
      this.processingChain = this.processingChain.then(async () => {
        // Decode mulaw and buffer normalized float32 samples
        for (let i = 0; i < raw.length; i++) {
          this.sampleBuf[this.sampleBufLen++] = MULAW_DECODE_TABLE[raw[i]] / 32767;
        }

        if (this.sampleBufLen < WINDOW) {
          resolve(null);
          return;
        }

        // Run inference on the accumulated window
        const prob = await this.runInference(this.sampleBuf.subarray(0, WINDOW));

        // Shift remaining samples to front of buffer
        const remaining = this.sampleBufLen - WINDOW;
        if (remaining > 0) {
          this.sampleBuf.copyWithin(0, WINDOW, this.sampleBufLen);
        }
        this.sampleBufLen = remaining;

        resolve(prob);
      });
    });

    return resultPromise;
  }

  private async runInference(audioWindow: Float32Array): Promise<number> {
    if (!sharedSession) throw new Error("VAD not initialized");

    // Prepend context from previous frame, then current audio window
    this.inputBuffer.set(this.context, 0);
    this.inputBuffer.set(audioWindow, CONTEXT);

    const result = await sharedSession.run({
      input: new ort.Tensor("float32", this.inputBuffer, [1, CONTEXT + WINDOW]),
      state: new ort.Tensor("float32", this.rnnState, [2, 1, 128]),
      sr: new ort.Tensor("int64", this.sampleRate),
    });

    // Update RNN state for next frame (copy into persistent array)
    this.rnnState.set(result.stateN!.data as Float32Array);

    // Save last 32 samples as context for next frame
    this.context = this.inputBuffer.slice(-CONTEXT);

    return (result.output!.data as Float32Array).at(0)!;
  }

  reset(): void {
    this.rnnState.fill(0);
    this.context.fill(0);
    this.sampleBuf.fill(0);
    this.sampleBufLen = 0;
  }
}

export function createVadState(): VadState {
  return new VadState();
}
