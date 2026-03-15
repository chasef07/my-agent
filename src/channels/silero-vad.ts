// silero-vad.ts — Local Silero VAD via ONNX for fast barge-in detection
// Shared ONNX session loaded once at startup; per-call VadState with own RNN hidden state.
// Uses 32-sample context window matching the official Silero VAD implementation.

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
    executionProviders: ["cpu"],
  });
  console.log(cyan("[VAD]") + " Silero VAD model loaded");
}

// --- Per-call state ---
const SR = 8000; // Twilio mulaw sample rate
const WINDOW = 256; // 32ms at 8kHz — Silero's expected frame size
const CONTEXT_SIZE = 32; // Context samples prepended to each frame

const STATE_SIZE = 2 * 1 * 128; // Silero v5 unified state: [2, 1, 128]

export class VadState {
  private state: ort.Tensor;
  private context: Float32Array;
  private inputBuffer: Float32Array;
  private sampleBuf: Float32Array;
  private sampleBufLen: number;
  private processingChain: Promise<void>;

  constructor() {
    this.state = new ort.Tensor("float32", new Float32Array(STATE_SIZE), [2, 1, 128]);
    this.context = new Float32Array(CONTEXT_SIZE);
    this.inputBuffer = new Float32Array(CONTEXT_SIZE + WINDOW);
    this.sampleBuf = new Float32Array(WINDOW + 160); // extra space for partial chunks
    this.sampleBufLen = 0;
    this.processingChain = Promise.resolve();
  }

  /** Decode mulaw base64 payload, accumulate samples, run inference when a full frame is ready.
   *  Returns speech probability 0-1 when a frame completes, null otherwise. */
  processChunk(base64Mulaw: string): Promise<number | null> {
    // Decode base64 → mulaw bytes → float32 PCM (normalized by int16 max)
    const raw = Buffer.from(base64Mulaw, "base64");
    for (let i = 0; i < raw.length; i++) {
      this.sampleBuf[this.sampleBufLen++] = MULAW_DECODE_TABLE[raw[i]] / 32767;
    }

    if (this.sampleBufLen < WINDOW) {
      return Promise.resolve(null);
    }

    // Chain processing to ensure ordered execution
    const resultPromise = new Promise<number | null>((resolve) => {
      this.processingChain = this.processingChain.then(async () => {
        let lastProb: number | null = null;

        while (this.sampleBufLen >= WINDOW) {
          lastProb = await this.runInference(this.sampleBuf.subarray(0, WINDOW));

          // Shift remaining samples to front
          const remaining = this.sampleBufLen - WINDOW;
          if (remaining > 0) {
            this.sampleBuf.copyWithin(0, WINDOW, this.sampleBufLen);
          }
          this.sampleBufLen = remaining;
        }

        resolve(lastProb);
      });
    });

    return resultPromise;
  }

  private async runInference(audioWindow: Float32Array): Promise<number> {
    if (!sharedSession) throw new Error("VAD not initialized");

    // Prepend context from previous frame (official Silero VAD approach)
    this.inputBuffer.set(this.context, 0);
    this.inputBuffer.set(audioWindow, CONTEXT_SIZE);

    const input = new ort.Tensor("float32", this.inputBuffer, [1, CONTEXT_SIZE + WINDOW]);
    const sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(SR)]), []);

    const result = await sharedSession.run({
      input,
      sr,
      state: this.state,
    });

    // Update RNN state and context for next frame
    this.state = result.stateN as ort.Tensor;
    this.context = this.inputBuffer.slice(-CONTEXT_SIZE);

    const prob = (result.output as ort.Tensor).data[0] as number;
    return prob;
  }

  reset(): void {
    this.state = new ort.Tensor("float32", new Float32Array(STATE_SIZE), [2, 1, 128]);
    this.context = new Float32Array(CONTEXT_SIZE);
    this.sampleBuf.fill(0);
    this.sampleBufLen = 0;
  }
}

export function createVadState(): VadState {
  return new VadState();
}
