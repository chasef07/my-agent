# Decomposition Plan

Break the monolithic `telephony.ts` (389 lines) into clean, single-responsibility modules. STT/LLM/TTS stay in the same process (latency-critical for phone calls). No microservices — modular monolith with clean internal boundaries.

## Target Structure

```
src/
  index.ts                          ~15 lines  — load config, pick mode, delegate
  cli.ts                            ~50 lines  — CLI REPL (extracted from index.ts)
  server.ts                         ~80 lines  — Fastify setup, routes, pre-call webhook
  agent.ts                                     — no changes
  config.ts                                    — no changes
  prompt.ts                                    — no changes
  logger.ts                                    — no changes
  channels/
    twilio-transport.ts             ~60 lines  — parse Twilio WS events, send audio/clear
    call-session.ts                ~100 lines  — per-call lifecycle (init, cleanup, state)
    audio-pipeline.ts              ~120 lines  — STT→LLM→TTS streaming, barge-in, fillers
    telephony-asr.ts                           — no changes
    telephony-tts.ts                           — no changes
  telephony.ts                                 — DELETED (replaced by above)
```

## Dependency Graph

```
index.ts → cli.ts (TTY mode)
         → server.ts (telephony mode)
              → call-session.ts
                   → audio-pipeline.ts
                        → telephony-asr.ts
                        → telephony-tts.ts
                   → twilio-transport.ts
              → agent.ts
              → config.ts
              → prompt.ts
```

---

## Phase 1: Extract `twilio-transport.ts`

Move from `telephony.ts`:
- `TwilioStartEvent`, `TwilioMediaEvent`, `TwilioStopEvent`, `TwilioEvent` type definitions
- `sendAudioToTwilio()` → `TwilioTransport.sendAudio()`
- `clearTwilioAudio()` → `TwilioTransport.clearAudio()`

Exports a class wrapping a raw WebSocket with typed event handling:

```typescript
class TwilioTransport {
  constructor(socket: WebSocket)
  sendAudio(streamSid: string, base64: string): void
  clearAudio(streamSid: string): void
  onStart(cb: (streamSid: string, callSid: string) => void): void
  onMedia(cb: (payload: string) => void): void
  onStop(cb: () => void): void
  onClose(cb: () => void): void
  onError(cb: (err: Error) => void): void
}
```

Purpose: isolate Twilio's WebSocket protocol from all other concerns. Nothing else in the codebase should know about Twilio's JSON message format.

---

## Phase 2: Extract `call-session.ts`

Move from `telephony.ts`:
- `ActiveCall` interface → `CallSession` class
- `initializeCall()` → `CallSession.initialize()`
- `cleanupCall()` → `CallSession.cleanup()`
- `ttsConfigFrom()` helper
- Tool call logging subscription
- Greeting TTS logic

```typescript
class CallSession {
  callSid: string
  streamSid: string
  transport: TwilioTransport
  agentSession: AgentSession | null
  asr: AsrSession | null
  tts: TtsSession | null
  processing: boolean
  turnCount: number

  constructor(callSid, streamSid, transport, config, agentOptions)
  async initialize(): Promise<void>     // start agent, ASR, greeting TTS
  async handleUtterance(text: string)   // delegate to audio-pipeline
  cleanup(): void                       // close ASR, TTS, log duration
}
```

Purpose: own the lifecycle of a single phone call. One instance per call, self-contained.

---

## Phase 3: Extract `audio-pipeline.ts`

Move from `telephony.ts`:
- `TOOL_FILLERS` array
- `FILLERS` set and `hasRealWords()` function
- Streaming subscription logic from `handleCallerUtterance()` (agent event → TTS token push)
- Barge-in detection from ASR partial transcript callback
- Filler injection on `tool_execution_start`
- Processing lock (spin-wait)
- Latency tracking (first token, first audio, turn complete)

```typescript
// Filler/barge-in utilities
function hasRealWords(text: string): boolean

// ASR callback factory — returns callbacks wired to barge-in + utterance handling
function createAsrCallbacks(session: CallSession, config: TelephonyConfig): AsrCallbacks

// The core streaming loop for one utterance
async function processUtterance(options: {
  agentSession: AgentSession
  text: string
  ttsConfig: TtsConfig
  transport: TwilioTransport
  streamSid: string
  session: CallSession           // for processing lock + turn count
}): Promise<void>
```

Purpose: the streaming "brain" — wires ASR output to agent input to TTS output, handles barge-in, fillers, and timing. This is the core logic that makes phone calls feel natural.

---

## Phase 4: Extract `server.ts`

Move from `telephony.ts`:
- Fastify creation and `@fastify/websocket` registration
- `application/x-www-form-urlencoded` content type parser
- `POST /voice` route (TwiML response)
- `GET /media-stream` WebSocket handler (creates TwilioTransport + CallSession)
- `GET /health` route
- `activeCalls` Map management
- Server startup logging

Add new:
- `POST /pre-call` route — generic skill warming webhook

```typescript
export async function startServer(options: {
  config: TelephonyConfig
  agentOptions: AgentOptions
}): Promise<FastifyInstance>
```

Pre-call webhook (generic, not AMD-specific):

```typescript
server.post("/pre-call", async () => {
  // Scan for warm.sh in any skill directory, execute what's found
  const warmScripts = glob.sync("workspace/skills/*/warm.sh");
  await Promise.all(warmScripts.map(script => execFile(script)));
  return { status: "ok" };
});
```

Purpose: pure HTTP/WebSocket server concerns. Only file that knows about Fastify.

---

## Phase 5: Extract `cli.ts`

Move from `index.ts`:
- `startAgent()` call for CLI session
- `attachLogger()` call
- Agent event subscription (text_delta → stdout)
- readline interface setup
- REPL line handler and close handler

```typescript
export async function startCli(options: {
  model: Model
  apiKey: string
  cwd: string
}): Promise<void>
```

Purpose: CLI REPL is its own concern, completely independent from telephony.

---

## Phase 6: Slim down `index.ts`

Replace current 86-line file with ~15 lines:

```typescript
import { loadConfig, getApiKey, createModel } from "./config.js";
import { startServer } from "./server.js";
import { startCli } from "./cli.js";

const config = loadConfig();
const apiKey = getApiKey(config);
const model = createModel(config);
const agentOptions = { model, apiKey, cwd: process.cwd() };

console.log(`my-agent v0.1.0`);
console.log(`Model: ${model.provider}/${model.id}`);

if (config.telephony?.enabled) {
  await startServer({ config: config.telephony, agentOptions });
}

if (process.stdin.isTTY) {
  await startCli({ model, apiKey, cwd: process.cwd() });
} else if (!config.telephony?.enabled) {
  console.error("No TTY and telephony not enabled. Nothing to do.");
  process.exit(1);
}
```

Purpose: routing only. No logic, no state.

---

## Phase 7: AMD skill warm script

Create `workspace/skills/amd/warm.sh`:

```bash
#!/bin/sh
amd auth 2>/dev/null || echo "[warm] amd auth failed"
```

This is the only AMD-specific piece. To remove AMD from any project: delete `workspace/skills/amd/`. To add a new integration: drop a folder with its own `SKILL.md` and optional `warm.sh`. The agent harness never changes.

---

## What Doesn't Change

| File | Lines | Reason |
|------|-------|--------|
| `telephony-asr.ts` | 113 | Already a clean, single-purpose ElevenLabs ASR client |
| `telephony-tts.ts` | 172 | Already a clean, single-purpose ElevenLabs TTS client |
| `agent.ts` | ~60 | Clean agent session factory |
| `config.ts` | ~50 | Clean config loader (already updated for Railway) |
| `prompt.ts` | ~80 | Clean dynamic prompt builder |
| `logger.ts` | ~40 | Clean debug logger |
| `workspace/SOUL.md` | — | Agent personality |
| `workspace/VOICE.md` | — | Speaking style |
| `workspace/skills/amd/SKILL.md` | — | AMD CLI instructions |

## Why NOT Microservices for STT/LLM/TTS

| Concern | Separate service? | Reason |
|---------|-------------------|--------|
| STT (ASR) | No | Already an external API (ElevenLabs). Local code is a 113-line WebSocket client. Wrapping it adds a network hop for zero benefit. |
| LLM (Agent) | No | Must stream token-by-token into TTS. Inter-process streaming adds latency and complexity. |
| TTS | No | Already an external API. Local code is a 172-line WebSocket client. |
| Barge-in | No | Requires ASR partial transcripts to immediately cancel TTS in the same event loop tick. Cross-service signaling too slow. |
| Pre-call warming | No (route) | Small enough to be a route on the same server. Independent lifecycle but not worth a separate deploy. |
| AMD CLI | Already separate | Go binary invoked via subprocess. Clean boundary already exists. |

## Execution Order

1. Phases 1-3 together (decompose telephony.ts into transport, session, pipeline)
2. Phase 4 (server.ts — depends on 1-3)
3. Phases 5-6 together (cli.ts + slim index.ts)
4. Phase 7 (warm.sh — independent)
5. Delete telephony.ts
6. Verify: `npx tsc --noEmit`, run locally, deploy to Railway
