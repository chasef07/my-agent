// sentence-detector.ts — Sentence boundary detection with period lookahead
// Prevents false flushes on abbreviations ("Dr."), decimals ("$29.99"),
// and dosages ("3.5mg"). Flushes immediately on ! and ?, but waits for
// confirmation (space + uppercase) after periods.

export interface TextChunk {
  text: string;
  flush: boolean;
}

// Minimum chars before period is considered a potential sentence end.
// Filters out things like "Dr.", "Mr.", "vs.", "St." (all ≤3 chars before .)
const MIN_WORD_BEFORE_PERIOD = 2;

// Max chars to accumulate before forcing a flush (even without sentence boundary)
const CHAR_THRESHOLD = 80;

export class SentenceDetector {
  private buffer = "";

  /** Feed a token, get back chunks to send to TTS.
   *  Each chunk has text and whether to trigger generation (flush). */
  feed(token: string): TextChunk[] {
    this.buffer += token;
    const results: TextChunk[] = [];

    // ! or ? at end → always a sentence end, flush immediately
    if (/[!?]\s*$/.test(this.buffer)) {
      results.push({ text: this.buffer, flush: true });
      this.buffer = "";
      return results;
    }

    // Confirmed period boundary: "lowercase word. Space Uppercase"
    // e.g., "today. Next" → flush "today. ", keep "Next"
    // Won't match: "Dr. Bach", "$29.99", "3.5mg"
    const match = this.buffer.match(
      new RegExp(`^(.*[a-z]{${MIN_WORD_BEFORE_PERIOD},}[.]\\s+)([A-Z].*)$`, "s"),
    );
    if (match) {
      results.push({ text: match[1], flush: true });
      this.buffer = match[2];
      return results;
    }

    // Period at end → hold for lookahead (wait for next token to confirm)
    if (/[.]\s*$/.test(this.buffer)) {
      // But don't hold forever — if buffer is very long, flush anyway
      if (this.buffer.length >= CHAR_THRESHOLD) {
        results.push({ text: this.buffer, flush: true });
        this.buffer = "";
      }
      return results;
    }

    // Character threshold — force flush for long runs without punctuation
    if (this.buffer.length >= CHAR_THRESHOLD) {
      results.push({ text: this.buffer, flush: true });
      this.buffer = "";
      return results;
    }

    // No boundary, no pending period — return accumulated text without flush
    const text = this.buffer;
    this.buffer = "";
    results.push({ text, flush: false });
    return results;
  }

  /** Flush everything remaining (called at end of turn). */
  drain(): TextChunk | null {
    if (this.buffer.trim()) {
      const text = this.buffer;
      this.buffer = "";
      return { text, flush: true };
    }
    this.buffer = "";
    return null;
  }

  reset(): void {
    this.buffer = "";
  }
}
