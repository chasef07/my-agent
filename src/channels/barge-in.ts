// barge-in.ts — VAD-based barge-in with tuned thresholds for PSTN audio
// PSTN echo cancellation attenuates inbound speech during playback,
// so probs typically peak 0.6-0.8 instead of 0.9+. Lower thresholds
// with consecutive-frame gating catch real speech without echo false positives.

import type { CallState } from "./call-session.js";

const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

// Tuning knobs — adjust these if false positives/negatives occur
export const BARGE_IN_THRESHOLD = 0.65; // lowered from 0.85 for echo-attenuated PSTN audio
export const BARGE_IN_FRAMES = 3; // ~96ms at 32ms/frame

export class BargeInDetector {
  private consecutiveFrames = 0;
  private onBargeIn: () => void;
  private lastLoggedProb = 0;

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

    // Log notable VAD activity during speaking (not every frame — only when prob is meaningful)
    if (callState === "speaking" && prob > 0.3 && Math.abs(prob - this.lastLoggedProb) > 0.1) {
      console.log(dim(`  [vad] prob=${prob.toFixed(2)} consecutive=${this.consecutiveFrames}`));
      this.lastLoggedProb = prob;
    }

    if (prob > BARGE_IN_THRESHOLD) {
      this.consecutiveFrames++;
      if (this.consecutiveFrames >= BARGE_IN_FRAMES) {
        console.log(yellow("  [vad barge-in]") + ` Caller interrupted (prob=${prob.toFixed(2)})`);
        this.onBargeIn();
        this.consecutiveFrames = 0;
      }
    } else {
      this.consecutiveFrames = 0;
    }
  }

  reset(): void {
    this.consecutiveFrames = 0;
    this.lastLoggedProb = 0;
  }
}

export function createBargeInDetector(onBargeIn: () => void): BargeInDetector {
  return new BargeInDetector(onBargeIn);
}
