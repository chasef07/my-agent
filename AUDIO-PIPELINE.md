# Audio Pipeline — Architecture & Lessons

How the telephony pipeline works, what makes it fast, and what to watch for.

## Architecture

```
Twilio (mulaw 8kHz)
  │
  ├─► ASR (ElevenLabs Scribe) ──► onPartialTranscript / onFinalTranscript
  │                                       │
  │                                       ▼
  ├─► VAD (Silero local ONNX) ──► BargeInDetector
  │                                       │
  │                                       ▼
  │                               processUtterance()
  │                                       │
  │                               LLM (streaming tokens)
  │                                       │
  │                               TTS (ElevenLabs WebSocket)
  │                                       │
  ◄───────────────────────────────────────┘
        base64 ulaw audio back to Twilio
```

Every audio chunk from Twilio is fed to two consumers in parallel:
1. **ASR** — cloud speech-to-text for transcription
2. **VAD** — local Silero model for instant barge-in detection (~1ms inference)

## State Machine

```
listening ──► processing ──► speaking ──► listening
    ▲              │              │            │
    │              │              ▼            │
    │              └──────── (empty response)  │
    │                                         │
    └──── (barge-in) ◄────────────────────────┘
```

Three states, strict transitions:
- **listening** — waiting for caller to speak. ASR transcripts are accepted.
- **processing** — LLM is generating a response. ASR transcripts are dropped (or trigger barge-in).
- **speaking** — TTS audio is being played to the caller. VAD/ASR can trigger barge-in.

Only one utterance is processed at a time. The state machine prevents race conditions.

## Streaming Pipeline (The Fast Path)

The key to low latency is that nothing waits for anything else to finish:

```
LLM token arrives
  → pushed to TTS immediately (no buffering except at sentence boundaries)
    → TTS generates audio chunk
      → sent to Twilio immediately
```

**Sentence-boundary flushing**: TTS buffers tokens until it sees `.` `!` `?` then sends with `flush: true`. This forces ElevenLabs to generate audio for that sentence immediately rather than waiting for more text. The tradeoff: more flush points = lower latency but slightly less natural prosody.

**TTS chunk schedule**: `[50, 100, 200, 260]` — ElevenLabs sends the first audio chunk after just 50 characters, then progressively larger chunks. This gets first audio out fast.

## Latency Targets

| Metric | Target | Typical |
|--------|--------|---------|
| First LLM token | < 300ms | 200-250ms |
| First audio to caller | < 500ms | 370-430ms |
| Full turn (short response) | < 700ms | 350-650ms |

Above 600ms first-audio, callers start to feel a lag. Above 1000ms, it feels broken.

The latency budget breaks down as:
- LLM first token: ~200ms
- TTS processing: ~150ms
- Network (server → Twilio → caller): ~50-100ms

## Barge-In (Two Layers)

### Layer 1: VAD (fast, ~100ms) — active during `processing` only
- **Silero VAD** runs locally on every audio chunk from Twilio
- Decodes mulaw → float32, runs ONNX inference per 32ms frame
- `BargeInDetector` requires **3 consecutive frames above 0.85 probability** (~96ms)
- **PSTN echo cancellation limitation**: During `speaking` state, the telephone network suppresses the caller's inbound audio to prevent echo. Twilio receives silence (rms=0), so VAD cannot detect speech while the agent is talking. VAD is effective during `processing` state (before TTS playback starts) when echo cancellation is not active.

### Layer 2: ASR partial transcript (primary during playback, ~300-500ms)
- If ASR emits a partial transcript with real words while agent is speaking, barge-in fires
- Slower because it round-trips through ElevenLabs cloud ASR
- **This is the primary barge-in mechanism during `speaking` state** due to the PSTN echo cancellation limitation above — ElevenLabs ASR can detect speech even through attenuated audio

### When barge-in fires:
1. TTS WebSocket is closed (stops generating audio)
2. `clearAudio` sent to Twilio (flushes its playback buffer)
3. State → `listening`
4. VAD and barge-in detector reset

## Mark-Based State Transitions (Critical)

**Problem**: The server finishes sending TTS audio to Twilio hundreds of milliseconds before the caller actually hears it. If state flips to `listening` when the server is done sending, the VAD barge-in window closes too early. The caller talks over the agent, but the server thinks the agent already finished — so it treats the interruption as a new turn instead of a barge-in.

**Solution**: Use Twilio's `mark` events. After the last TTS chunk is sent, we send a mark to Twilio instead of transitioning state. Twilio sends the mark event back when the audio has actually been played to the caller. Only then do we transition to `listening`.

```
Server sends last audio chunk
Server sends mark event ──────────────►  Twilio buffers audio
State stays "speaking"                    Twilio plays audio to caller
VAD barge-in still active                 ...
                                          Caller hears the end
                                          Twilio sends mark back
State → "listening"  ◄────────────────── Mark received
```

Without marks, barge-in has a blind spot equal to Twilio's playback buffer (~300-800ms depending on network). With marks, the barge-in window covers the entire time the caller is hearing the agent.

## Filler Word Filtering

```typescript
const FILLERS = new Set(["um", "uh", "uhh", "umm", "hmm", "hm", "ah", "oh", "er", "like", "so", "well", "actually"]);
```

Filler words are filtered at two points:
- **ASR partial transcripts** — don't trigger barge-in for "um" or "uh"
- **ASR final transcripts** — don't send filler-only utterances to the LLM

This prevents the agent from responding to throat-clearing or thinking noises.

## ASR Details

- **ElevenLabs Scribe v2** with native `ULAW_8000` format (no transcoding needed)
- **VAD-based commit strategy** — ElevenLabs detects silence and commits the transcript automatically
- `vadSilenceThresholdSecs: 1.5` — how long silence before committing (too low = cuts off mid-thought, too high = slow)
- `minSpeechDurationMs: 200` — ignores very short sounds
- `minSilenceDurationMs: 500` — minimum pause before considering it silence
- **Audio buffering** — chunks are buffered until the WebSocket session is ready, then flushed
- **Keepalive ping** every 15s — prevents idle timeout during long tool executions
- **Deduplication** — VAD can sometimes commit the same utterance twice; tracked with `lastTranscript`

## TTS Details

- **ElevenLabs WebSocket streaming** — tokens pushed directly as LLM generates them
- **Output format**: `ulaw_8000` — matches Twilio's expected format, no transcoding
- **Voice settings**: `stability: 0.48`, `similarity_boost: 0.8`, `speed: 1.0`
- **Init message quirk**: ElevenLabs sends `isFinal` for the init space `" "` — we only honor `isFinal` after `flush()` is called to avoid premature session close
- **Cancel support**: On barge-in, the TTS WebSocket is closed immediately, stopping audio generation

## Empty Response Handling

If the LLM returns no text (no `text_delta` events):
- `agentText` stays empty, logged as `[agent] ""`
- No TTS audio is produced, so state never reaches `speaking`
- The `finally` block in `processUtterance` catches this: if state is still `processing`, it resets to `listening`
- **Without this safety net**, the state machine would get stuck in `processing` forever, dropping all subsequent utterances

## Turn Management

- **Turn counter** (`session.turnCount`) prevents stale callbacks from firing. Each TTS audio/done callback checks `session.turnCount !== thisTurn` before acting.
- **Turn timeout** (30s) prevents hung LLM calls from blocking the pipeline forever.
- `processUtterance` is called without `await` (fire-and-forget from the ASR callback). The state machine prevents overlapping turns.

## Known Issues & Areas to Improve

### Tool calling (blocker)
GLM-4.7 cannot format tool call arguments correctly. It sends `bash` with empty `{}` args, then spirals into calling unnamed tools. After failed tool calls, the model returns empty responses for all subsequent turns. Need a model with reliable tool calling or a text-based tool invocation pattern.

### Latency creep on long conversations
Context grows with each turn. By turn 8-9, first-token latency climbs to 400ms+ and first-audio to 600ms. Compaction is enabled but may not be aggressive enough. Consider pruning old turns or capping context size.

### Response length
The model sometimes gives paragraph-length responses that take 800ms+ to fully stream. On a phone call, shorter responses (1-2 sentences) feel more natural and reduce the chance of being interrupted mid-thought. Consider a max token limit or a prompt instruction to keep responses brief.

### ASR silence threshold
`vadSilenceThresholdSecs: 1.5` means the system waits 1.5s of silence before committing a transcript. This adds perceived latency — the caller finishes speaking, then waits 1.5s before the agent starts responding. Lowering this risks cutting off callers mid-thought. Could be made dynamic based on context (shorter for yes/no questions, longer for open-ended).

### PSTN echo cancellation limits VAD barge-in
Standard telephony networks suppress the return audio path when one party is speaking (echo cancellation). This means Twilio's inbound audio stream contains silence (rms=0) while the agent's TTS audio plays to the caller. No local VAD implementation can detect caller speech in silence. This is not a Twilio configuration — it's fundamental PSTN behavior. ASR barge-in (Layer 2, ~300-500ms) is the effective barge-in mechanism during playback. VAD remains useful during `processing` state before TTS begins.

## File Map

| File | Purpose |
|------|---------|
| `server.ts` | Fastify HTTP/WS server, wires Twilio transport to session |
| `call-session.ts` | Per-call lifecycle, owns all session state |
| `audio-pipeline.ts` | Core STT→LLM→TTS loop, state machine, barge-in callbacks |
| `twilio-transport.ts` | Typed wrapper around Twilio's WebSocket protocol |
| `telephony-asr.ts` | ElevenLabs Scribe streaming ASR |
| `telephony-tts.ts` | ElevenLabs WebSocket streaming TTS |
| `silero-vad.ts` | Local Silero ONNX model for speech detection |
| `barge-in.ts` | Consecutive-frame logic for VAD-based interruption |
