// silero-vad.ts — Local Silero VAD via ONNX for fast barge-in detection
// Shared ONNX session loaded once at startup; per-call VadState with own RNN hidden state.

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

const STATE_SIZE = 2 * 1 * 128; // Silero v5 unified state: [2, 1, 128]

export class VadState {
  private state: ort.Tensor;
  private buffer: Float32Array;
  private bufferPos: number;
  private processingChain: Promise<void>;

  constructor() {
    this.state = new ort.Tensor("float32", new Float32Array(STATE_SIZE), [2, 1, 128]);
    this.buffer = new Float32Array(WINDOW);
    this.bufferPos = 0;
    this.processingChain = Promise.resolve();
  }

  /** Decode mulaw base64 payload, accumulate samples, run inference when a full frame is ready.
   *  Returns speech probability 0-1 when a frame completes, null otherwise. */
  processChunk(base64Mulaw: string): Promise<number | null> {
    // Decode base64 → mulaw bytes → float32 PCM (standard G.711 int16 / 32767)
    const raw = Buffer.from(base64Mulaw, "base64");
    const samples = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      samples[i] = MULAW_DECODE_TABLE[raw[i]] / 32767;
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
      state: this.state,
    });

    // Update RNN state for next frame
    this.state = result.stateN as ort.Tensor;

    const prob = (result.output as ort.Tensor).data[0] as number;
    return prob;
  }

  reset(): void {
    this.state = new ort.Tensor("float32", new Float32Array(STATE_SIZE), [2, 1, 128]);
    this.buffer = new Float32Array(WINDOW);
    this.bufferPos = 0;
  }
}

export function createVadState(): VadState {
  return new VadState();
}
