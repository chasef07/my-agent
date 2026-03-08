# My Agent — Blueprint

> A self-improving, model-agnostic coding agent built on pi-mono.
> Lightweight. Fully understood. Every line intentional.

---

## Philosophy

- **Understand everything.** No black boxes. Every file, every function, every decision is deliberate.
- **Build on pi-mono, own the rest.** Pi-mono provides the foundation (LLM abstraction, agent loop, coding tools, sessions). Everything above that is ours — proprietary, custom, cutting edge.
- **Self-improving.** The agent can modify its own code, tools, skills, prompts, and memory — safely, through git + tests + restart.
- **Model-agnostic.** Plug in any LLM via API key. Anthropic, OpenAI, Google, Groq, xAI, Ollama, whatever comes next.
- **Collaborative build.** Every step is discussed, understood, and approved before implementation.

---

## The 6 Pillars

| # | Pillar | What it means |
|---|--------|---------------|
| 1 | **Coding Agent CLI Harness** | A terminal-based agent that can read, write, edit code, run commands, and have multi-turn conversations |
| 2 | **Long-Term Memory** | The agent remembers things across sessions — curated facts, daily logs, auto-flush before compaction |
| 3 | **Dynamic Prompt Assembly** | System prompt is built from workspace files at session start — editable, composable, version-controlled |
| 4 | **Skill Loading** | Skills are directories with instructions + optional tools — the agent can load, use, and create new ones |
| 5 | **Pluggable Model Provider** | Any LLM, any provider, swappable at runtime — your API keys, your choice |
| 6 | **WhatsApp Channel** | Agent accessible via WhatsApp with per-chat sessions, isolated memory, message routing |

**Bonus Pillar:**

| 7 | **Self-Improvement** | The agent can modify its own source code, tools, skills, and prompts — with guardrails |

---

## Architecture Overview

### What pi-mono gives us (dependencies, not forked)

```
@mariozechner/pi-ai             → Unified LLM API across all providers
@mariozechner/pi-agent-core     → Agent loop, tool calling, state machine, streaming
@mariozechner/pi-coding-agent   → Coding tools (read/write/edit/bash), sessions, compaction, extensions
@mariozechner/pi-tui            → Terminal UI with markdown rendering (optional)
```

### What we build (proprietary)

```
prompt.ts                → Dynamic system prompt assembly from workspace files
memory.ts                → Long-term memory (MEMORY.md + daily logs + optional vector search)
skills.ts                → Skill directory scanner and tool loader
tools/memory-tools.ts    → memory_write, memory_search agent tools
tools/self-improve.ts    → Build + test + commit + restart cycle
extensions/              → Memory flush, context pruning, self-improve guardrails
channels/whatsapp.ts     → Baileys integration with per-chat sessions
workspace/               → Bootstrap files, skills, memory — all self-modifiable
```

### The agent loop (what happens each turn)

```
1. INTAKE         → Receive message (CLI input or WhatsApp message)
2. ROUTE          → Determine which session this belongs to
3. CONTEXT        → Assemble: system prompt + conversation history + tool results + workspace files
4. INFERENCE      → Send to LLM via pi-ai (any provider)
5. TOOL EXECUTION → Agent calls tools, results feed back into the loop
6. REPLY          → Stream response back to CLI or WhatsApp
7. PERSIST        → Session saved to JSONL, memory updated if needed
```

### The self-improvement cycle

```
1. Agent identifies something to improve (tool, prompt, skill, extension)
2. Agent reads its own source code via read tool
3. Agent modifies code via edit/write tools
4. Agent calls self_improve tool:
   a. npm run build  → must pass
   b. npm test       → must pass
   c. git commit     → change is versioned
   d. signal restart → process wrapper restarts the agent
5. Agent resumes from persisted session with the improvement applied
```

---

## Project Structure

```
~/my-agent/
├── run.ts                              # Process wrapper — PROTECTED, agent cannot modify
├── src/
│   ├── index.ts                        # CLI entrypoint, session setup, readline or pi-tui
│   ├── agent.ts                        # createAgentSession wiring, model resolution
│   ├── prompt.ts                       # buildSystemPrompt() — assembles from workspace files
│   ├── memory.ts                       # MEMORY.md read/write/flush, daily logs
│   ├── skills.ts                       # Scan workspace/skills/, load tool definitions
│   ├── tools/
│   │   ├── memory-tools.ts             # memory_write, memory_search AgentTool definitions
│   │   └── self-improve.ts             # Build + test + commit + restart signal
│   ├── extensions/
│   │   ├── memory-flush.ts             # Auto-persist important facts before compaction
│   │   ├── context-pruning.ts          # Trim large tool results from old turns
│   │   └── self-improve-guard.ts       # Block modifications to protected files
│   ├── channels/
│   │   └── whatsapp.ts                 # Baileys → per-chat agent sessions
│   └── router.ts                       # CLI vs WhatsApp message dispatch
├── workspace/
│   ├── AGENTS.md                       # Operating instructions (self-modifiable)
│   ├── SOUL.md                         # Persona, tone, boundaries (self-modifiable)
│   ├── USER.md                         # Your profile and preferences
│   ├── IDENTITY.md                     # Agent name and characteristics
│   ├── TOOLS.md                        # Tool guidance and conventions
│   ├── MEMORY.md                       # Long-term curated memory
│   ├── memory/                         # Daily append-only logs (YYYY-MM-DD.md)
│   └── skills/                         # Skill directories (self-modifiable)
│       └── example-skill/
│           ├── SKILL.md                # Instructions for the agent
│           └── tools.ts                # Optional AgentTool definitions
├── tests/
│   ├── smoke.test.ts                   # Does the agent start and respond?
│   ├── prompt.test.ts                  # Does prompt assembly work correctly?
│   ├── memory.test.ts                  # Does memory read/write work?
│   └── skills.test.ts                  # Does skill loading work?
├── auth.json                           # API keys per provider (GITIGNORED)
├── config.json                         # Model selection, workspace path, settings
├── package.json
├── tsconfig.json
├── .gitignore
└── BLUEPRINT.md                        # This file
```

### Protected files (agent cannot modify)

- `run.ts` — the process wrapper / safety net
- `auth.json` — API keys
- `node_modules/` — upstream dependencies
- `.git/` — git internals

### Self-modifiable files (agent can improve)

- Everything in `src/` (with build + test gate)
- Everything in `workspace/` (immediate effect)
- `tests/` (agent can add tests for its improvements)
- `config.json` (agent can suggest model changes)

---

## Build Plan — Step by Step

Each step is a conversation. We discuss what we're building, why, make decisions together, write prompts together, and I only proceed with your approval.

---

### Phase 1: Foundation

#### Step 1.1 — Project scaffold
- Initialize the project: `package.json`, `tsconfig.json`, `.gitignore`, git repo
- Install pi-mono packages: `pi-ai`, `pi-agent-core`, `pi-coding-agent`
- Install dev deps: TypeScript, Vitest
- **Questions to answer together:**
  - Project name?
  - Node.js or Bun as runtime?
  - Any other dev tooling preferences?

#### Step 1.2 — Auth and model config
- Create `auth.json` structure for API keys
- Create `config.json` for model selection and settings
- Wire up `pi-ai`'s `getModel()` with your API key
- **Questions to answer together:**
  - Which provider/model do you want as default?
  - Do you want to support local models (Ollama) from day one?
  - Auth storage: JSON file, env vars, or both?

#### Step 1.3 — Minimal CLI harness
- Create `src/index.ts` — readline-based CLI
- Create `src/agent.ts` — `createAgentSession` with coding tools
- Wire up: type a message → get a response from the LLM
- Verify it works end-to-end with your API key
- **Questions to answer together:**
  - Plain readline or pi-tui (richer terminal UI)?
  - Which coding tools to enable by default? (read/write/edit/bash + grep/find/ls)
  - Working directory for the agent — its own project dir?

#### Step 1.4 — Process wrapper
- Create `run.ts` — the outer loop that restarts the agent on self-modification
- Implement restart signal mechanism (exit code or file watch)
- Verify: kill the process → wrapper restarts it
- **Questions to answer together:**
  - Restart strategy: exit code 42 vs .restart file vs both?
  - Should the wrapper log restarts?

#### Step 1.5 — Session persistence
- Wire up `SessionManager.create()` / `SessionManager.continueRecent()`
- Verify: start a conversation → kill the process → restart → conversation continues
- **Questions to answer together:**
  - Where to store sessions? (default: `.sessions/` in project dir)
  - Auto-resume last session on startup, or always start fresh?

**Milestone: A working CLI coding agent that talks to any LLM, persists sessions, and can restart gracefully.**

---

### Phase 2: Dynamic Prompt

#### Step 2.1 — Workspace bootstrap files
- Create the `workspace/` directory structure
- Write initial versions of: `AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `TOOLS.md`
- **This is a major creative step — we write these together:**
  - What should the agent's personality be?
  - What are its core operating instructions?
  - What boundaries/guardrails go in the prompt vs in code?
  - How should it refer to you?
  - What's the agent's name?

#### Step 2.2 — Prompt assembly engine
- Create `src/prompt.ts` — `buildSystemPrompt()`
- Read workspace files, truncate to limits (20k/file, 150k total)
- Inject runtime context (date, model, OS, workspace path)
- Inject skills manifest (compact — names + descriptions)
- Skip missing/empty files
- **Questions to answer together:**
  - File load order (priority)?
  - Custom sections beyond the OpenClaw defaults?
  - Token budget allocation across sections?

#### Step 2.3 — Prompt integration
- Wire `buildSystemPrompt()` into `createAgentSession`
- Verify: edit a workspace file → restart → agent behavior changes
- Write `tests/prompt.test.ts`

**Milestone: System prompt assembled dynamically from editable workspace files.**

---

### Phase 3: Long-Term Memory

#### Step 3.1 — Memory file structure
- Create `workspace/MEMORY.md` (curated durable facts)
- Create `workspace/memory/` directory (daily logs)
- Implement `readMemory()` and `writeMemory()` in `src/memory.ts`
- **Questions to answer together:**
  - What goes in MEMORY.md vs daily logs?
  - Max size for MEMORY.md before it needs pruning?
  - Format/structure within the files?

#### Step 3.2 — Memory tools
- Create `src/tools/memory-tools.ts`
- `memory_write` tool — agent can persist facts to MEMORY.md or daily log
- `memory_read` tool — agent can read specific memory files
- Wire into the agent's tool set
- **Questions to answer together:**
  - Should the agent always have memory tools, or opt-in?
  - Should there be a `memory_forget` tool?
  - Categories/tags for memories?

#### Step 3.3 — Memory injection into prompt
- Load `MEMORY.md` content into the system prompt at session start
- Truncate to 20k chars with marker
- **Questions to answer together:**
  - Should daily logs also be injected, or just searchable?
  - How much of the token budget goes to memory?

#### Step 3.4 — Auto-flush before compaction
- Create `src/extensions/memory-flush.ts`
- Hook into `session_before_compact` event
- Ask the agent to persist important facts before context gets summarized
- Write result to MEMORY.md
- **Questions to answer together:**
  - What prompt do we use for the auto-flush turn?
  - Should the user see this happen, or should it be silent?

#### Step 3.5 — (Optional) Vector search
- Add embeddings for semantic memory search
- SQLite + `sqlite-vec` for vector storage
- Hybrid BM25 + vector search
- `memory_search` tool for the agent
- **Questions to answer together:**
  - Which embedding provider? (OpenAI, local via Ollama, etc.)
  - Is this needed now or can it wait?

**Milestone: Agent remembers things across sessions, auto-persists before compaction.**

---

### Phase 4: Skill Loading

#### Step 4.1 — Skill directory structure
- Define the skill format: `workspace/skills/<name>/SKILL.md` + optional `tools.ts`
- Create `src/skills.ts` — scanner that reads skill directories
- **Questions to answer together:**
  - Skill manifest format?
  - Can skills have dependencies on other skills?
  - Priority/override rules when skills conflict?

#### Step 4.2 — Skill injection into prompt
- Skill names + descriptions go into system prompt (compact)
- Full SKILL.md stays on disk — agent reads it on-demand with the `read` tool
- Wire into `buildSystemPrompt()`

#### Step 4.3 — Skill tool loading
- Skills with `tools.ts` export `AgentTool` definitions
- `loadSkillTools()` scans and merges them into the agent's tool set
- Wire into `createAgentSession`

#### Step 4.4 — First skills
- Create 1-2 example skills together to validate the system
- **Questions to answer together:**
  - What skills do you want first?
  - Web search? Code review? Deployment? Daily briefing?

**Milestone: Agent can load and use skills from the workspace. Agent can create new skills for itself.**

---

### Phase 5: Pluggable Model Provider

#### Step 5.1 — Model resolution
- Create model resolution logic in `src/agent.ts`
- Read `config.json` for default provider + model
- Support runtime switching via CLI command (e.g., `/model openai gpt-4o`)
- **Questions to answer together:**
  - Default model?
  - Should the agent be able to switch its own model mid-conversation?
  - Cost tracking/budgets?

#### Step 5.2 — Auth management
- `auth.json` stores API keys per provider
- Support env var fallback (e.g., `ANTHROPIC_API_KEY`)
- Never committed to git
- **Questions to answer together:**
  - Any providers beyond Anthropic + OpenAI + Google to support from day one?
  - Key rotation or expiry handling?

#### Step 5.3 — Local model support
- Configure Ollama or any OpenAI-compatible endpoint
- Custom `Model` definition for local models
- Verify: agent works fully offline with a local model
- **Questions to answer together:**
  - Which local model to test with?
  - Different behavior/limits for local vs cloud models?

**Milestone: Agent works with any LLM provider. Swap models with one config change.**

---

### Phase 6: Self-Improvement

#### Step 6.1 — Self-improve tool
- Create `src/tools/self-improve.ts`
- Workflow: build → test → git commit → signal restart
- Agent uses standard `edit`/`write` tools to make changes, then calls `self_improve` to validate and apply
- **Questions to answer together:**
  - What must pass before a self-modification is accepted?
  - Commit message format?
  - Should there be a confirmation step (agent asks you before committing)?

#### Step 6.2 — Guardrails extension
- Create `src/extensions/self-improve-guard.ts`
- Block modifications to protected files: `run.ts`, `auth.json`, `node_modules/`, `.git/`
- Log all self-modifications
- **Questions to answer together:**
  - What else should be protected?
  - Should there be a "dry run" mode for self-modifications?
  - Approval required for changes to `src/` but not `workspace/`?

#### Step 6.3 — Context pruning extension
- Create `src/extensions/context-pruning.ts`
- Trim large tool results from old turns to save context space
- **Questions to answer together:**
  - At what size should tool results be trimmed?
  - How many turns back before pruning kicks in?

#### Step 6.4 — Test suite for self-improvement
- Smoke test: agent starts and responds
- Build test: TypeScript compiles
- Memory test: read/write works
- Prompt test: assembly works
- The agent must pass ALL of these before any self-modification commits
- **Questions to answer together:**
  - Additional tests?
  - Should the agent be able to add its own tests?

**Milestone: Agent can safely modify its own code, tools, skills, and prompts — with guardrails.**

---

### Phase 7: WhatsApp Channel

#### Step 7.1 — Baileys integration
- Install `@whiskeysockets/baileys`
- Create `src/channels/whatsapp.ts`
- QR code authentication
- Message receive/send
- **Questions to answer together:**
  - Trigger pattern: mention-based, keyword, or all DMs?
  - Group chat support or DMs only?
  - Media handling (images, audio, video)?

#### Step 7.2 — Per-chat sessions
- Each WhatsApp chat gets its own agent session
- Isolated JSONL history per chat
- Isolated memory per chat (or shared — your choice)
- **Questions to answer together:**
  - Shared MEMORY.md across chats, or per-chat memory?
  - Session timeout/cleanup?
  - Max concurrent sessions?

#### Step 7.3 — Message router
- Create `src/router.ts`
- CLI messages go directly to the agent
- WhatsApp messages route through Baileys → queue → agent → reply
- Per-chat concurrency control (one message at a time per chat)
- **Questions to answer together:**
  - Message queue strategy?
  - Error handling: what does the user see when something fails?

#### Step 7.4 — DM policy and security
- Allowlist for who can message the agent
- Pairing flow for unknown senders
- Rate limiting
- **Questions to answer together:**
  - Open to anyone, or allowlist only?
  - How should the agent handle unknown senders?

**Milestone: Agent accessible via WhatsApp with isolated per-chat sessions.**

---

### Phase 8: Polish and Harden

#### Step 8.1 — Logging and observability
- Structured logging for all agent activity
- Token usage and cost tracking
- Session statistics

#### Step 8.2 — launchd service
- Register as a macOS launchd service
- Auto-start on boot
- Log to file

#### Step 8.3 — Backup and recovery
- Git-based backup of workspace and source
- Session export/import
- Memory backup strategy

#### Step 8.4 — Documentation
- README with setup instructions
- Document every workspace file and what it controls
- Document how to add skills
- Document how self-improvement works

---

## Dependencies

```json
{
  "dependencies": {
    "@mariozechner/pi-ai": "latest",
    "@mariozechner/pi-agent-core": "latest",
    "@mariozechner/pi-coding-agent": "latest",
    "@mariozechner/pi-tui": "latest",
    "@whiskeysockets/baileys": "^6.0.0",
    "better-sqlite3": "^11.0.0",
    "glob": "^11.0.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@types/better-sqlite3": "^7.0.0",
    "@types/node": "^22.0.0"
  }
}
```

---

## Key Decisions to Make Before Building

These are questions we'll answer together as we build each phase:

1. **Agent name and persona** — Who is this agent? What's its voice?
2. **Default model** — Which LLM do we start with?
3. **Runtime** — Node.js or Bun?
4. **CLI style** — Plain readline or pi-tui?
5. **Memory depth** — Simple markdown files or vector search from day one?
6. **Self-improvement approval** — Agent auto-commits, or asks you first?
7. **WhatsApp scope** — DMs only, or group chats too?
8. **First skills** — What capabilities does the agent need immediately?

---

## How We'll Build This

**For every step:**

1. I explain what we're building and why
2. I ask you questions about decisions that affect the implementation
3. You give your preferences and approval
4. We write prompts and configuration together (especially workspace files)
5. I implement with full explanation of every line
6. We test together
7. We move to the next step

**Nothing gets built without your understanding and approval.**

---

## References

- [pi-mono GitHub](https://github.com/badlogic/pi-mono)
- [pi-agent-core Architecture](https://deepwiki.com/badlogic/pi-mono/3-@mariozechnerpi-agent-core)
- [Building a Custom Agent with PI](https://nader.substack.com/p/how-to-build-a-custom-agent-framework)
- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [OpenClaw Agent Docs](https://docs.openclaw.ai/concepts/agent)
- [OpenClaw Memory Docs](https://docs.openclaw.ai/concepts/memory)
- [OpenClaw Compaction Docs](https://docs.openclaw.ai/concepts/compaction)
- [OpenClaw System Prompt Docs](https://docs.openclaw.ai/concepts/system-prompt)
- [OpenClaw Context Docs](https://docs.openclaw.ai/concepts/context)
- [OpenClaw Workspace Docs](https://docs.openclaw.ai/concepts/agent-workspace)
- [NanoClaw GitHub](https://github.com/qwibitai/nanoclaw)
