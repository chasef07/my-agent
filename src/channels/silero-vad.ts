// silero-vad.ts — Local Silero VAD via ONNX for fast barge-in detection
// Shared ONNX session loaded once at startup; per-call VadState with own RNN hidden state.

import * as ort from "onnxruntime-node";

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

// --- Mulaw decode lookup table (standard G.711) ---
const MULAW_TABLE = new Float32Array(256);
{
  for (let i = 0; i < 256; i++) {
    const mu = ~i & 0xff;
    const sign = mu & 0x80 ? -1 : 1;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    const sample = sign * ((2 * mantissa + 33) * (1 << exponent) - 33);
    // Normalize to -1..1 (mulaw range is roughly -8031..8031)
    MULAW_TABLE[i] = sample / 8031;
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

export class VadState {
  private h: ort.Tensor;
  private c: ort.Tensor;
  private buffer: Float32Array;
  private bufferPos: number;
  private processingChain: Promise<void>;

  constructor() {
    // Silero v5 RNN state: 2 x 1 x 64
    this.h = new ort.Tensor("float32", new Float32Array(2 * 64), [2, 1, 64]);
    this.c = new ort.Tensor("float32", new Float32Array(2 * 64), [2, 1, 64]);
    this.buffer = new Float32Array(WINDOW);
    this.bufferPos = 0;
    this.processingChain = Promise.resolve();
  }

  /** Decode mulaw base64 payload, accumulate samples, run inference when a full frame is ready.
   *  Returns speech probability 0-1 when a frame completes, null otherwise. */
  processChunk(base64Mulaw: string): Promise<number | null> {
    // Decode base64 → mulaw bytes → float32 PCM
    const raw = Buffer.from(base64Mulaw, "base64");
    const samples = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      samples[i] = MULAW_TABLE[raw[i]];
    }

    // Chain processing to ensure ordered execution
    const resultPromise = new Promise<number | null>((resolve) => {
      this.processingChain = this.processingChain.then(async () => {
        let lastProb: number | null = null;

        let offset = 0;
        while (offset < samples.length) {
          const space = WINDOW - this.bufferPos;
          const toCopy = Math.min(space, samples.length - offset);
          this.buffer.set(samples.subarray(offset, offset + toCopy), this.bufferPos);
          this.bufferPos += toCopy;
          offset += toCopy;

          if (this.bufferPos === WINDOW) {
            lastProb = await this.runInference();
            this.bufferPos = 0;
          }
        }

        resolve(lastProb);
      });
    });

    return resultPromise;
  }

  private async runInference(): Promise<number> {
    if (!sharedSession) throw new Error("VAD not initialized");

    const input = new ort.Tensor("float32", new Float32Array(this.buffer), [1, WINDOW]);
    const sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(SR)]), []);

    const result = await sharedSession.run({
      input,
      sr,
      h: this.h,
      c: this.c,
    });

    // Update RNN state for next frame
    this.h = result.hn as ort.Tensor;
    this.c = result.cn as ort.Tensor;

    const prob = (result.output as ort.Tensor).data[0] as number;
    return prob;
  }

  reset(): void {
    this.h = new ort.Tensor("float32", new Float32Array(2 * 64), [2, 1, 64]);
    this.c = new ort.Tensor("float32", new Float32Array(2 * 64), [2, 1, 64]);
    this.buffer = new Float32Array(WINDOW);
    this.bufferPos = 0;
  }
}

export function createVadState(): VadState {
  return new VadState();
}
