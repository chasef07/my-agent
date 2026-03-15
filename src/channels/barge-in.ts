// barge-in.ts — Pure logic for VAD-based barge-in decision
// Tracks consecutive high-probability VAD frames to fire a barge-in callback.

import type { CallState } from "./call-session.js";

const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

// Tuning knobs — adjust these if false positives/negatives occur
export const BARGE_IN_THRESHOLD = 0.85;
export const BARGE_IN_FRAMES = 3;

export class BargeInDetector {
  private consecutiveFrames = 0;
  private onBargeIn: () => void;

  constructor(onBargeIn: () => void) {
    this.onBargeIn = onBargeIn;
  }

  /** Called with each VAD probability result. Only triggers during speaking/processing states. */
  onVadResult(prob: number, callState: CallState): void {
    // Only detect barge-in when agent is speaking or processing
    if (callState !== "speaking" && callState !== "processing") {
      this.consecutiveFrames = 0;
      return;
    }

    if (prob > BARGE_IN_THRESHOLD) {
      this.consecutiveFrames++;
      if (this.consecutiveFrames >= BARGE_IN_FRAMES) {
        console.log(yellow("  [vad barge-in]") + " Caller interrupted");
        this.onBargeIn();
        this.consecutiveFrames = 0;
      }
    } else {
      this.consecutiveFrames = 0;
    }
  }

  reset(): void {
    this.consecutiveFrames = 0;
  }
}

export function createBargeInDetector(onBargeIn: () => void): BargeInDetector {
  return new BargeInDetector(onBargeIn);
}
