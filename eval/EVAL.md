# Eval System

A self-improving loop that tests the agent against real production failures, proposes prompt changes, keeps what works, and reverts what doesn't.

## Quick Start

```bash
# Set env vars
export ANTHROPIC_API_KEY=sk-ant-...       # Claude (judge + scenario generator)
export TOGETHER_API_KEY=tgp_v1_...        # Agent model
export ADVANCEDMD_USERNAME=...            # AMD CLI
export ADVANCEDMD_PASSWORD=...
export ADVANCEDMD_OFFICE_KEY=...
export ADVANCEDMD_APP_NAME=...
export DATABASE_URL=postgres://...        # Production transcript DB
```

## The Flywheel

```
   Production calls (Railway)
            ↓
   extract: pull transcripts, classify failures
            ↓
   research --from-extracted: iterate on prompt
            ↓
   commit + deploy improved prompt
            ↓
   monitor next batch of calls → repeat
```

### Step 1: Extract failures from production

```bash
npx tsx eval/run.ts extract --days 7
```

Connects to the Postgres transcript database, pulls recent calls, uses Claude to classify each one for failures (tool errors, hallucinations, loops, caller frustration). Automatically filters out pure transfer scenarios — only keeps interesting ones that involve tool calls, scheduling workflows, insurance questions, and patient registration.

Saves scenarios to `eval/results/extracted-scenarios.json`.

### Step 2: Research loop (iterative prompt improvement)

```bash
# Using real production failures (recommended)
npx tsx eval/run.ts research --from-extracted --max 10

# Using synthetic adversarial scenarios
npx tsx eval/run.ts research --scenarios 8 --max 10
```

The research loop:
1. Runs **baseline** — tests current prompt against all scenarios
2. Claude proposes **ONE surgical change** to SOUL.md, VOICE.md, or a skill file
3. Applies the change, re-runs all scenarios
4. **Keep** if score improves, **revert** if not
5. Repeats for `--max` experiments
6. Saves best prompt versions + HTML report with charts

The `--from-extracted` flag uses real caller conversations from production. Without it, Claude generates adversarial scenarios from scratch.

### Step 3: Workflow eval (end-to-end tool call testing)

```bash
npx tsx eval/run.ts workflows
```

Runs 8 hardcoded multi-turn conversations that test complete flows:

| Scenario | What it tests |
|----------|---------------|
| Existing patient booking | verify → availability → book |
| Check appointments | verify → appointments |
| New patient registration | verify (not found) → add-patient → availability |
| Cancel appointment | verify → appointments → cancel |
| Location/hours question | knowledge-base skill reading |
| Insurance question | insurance skill reading + routing |
| Pediatric patient | registration + Bach-only routing |
| Reschedule | verify → appointments → cancel → availability → book |

These use real AMD credentials and make actual tool calls.

### Step 4: Deploy

```bash
# Commit the improved prompt
git add workspace/ && git commit -m "Prompt improvements from eval run"
git push

# Deploy to Railway
railway up --detach
```

## Scoring

Each scenario produces a composite score:

```
score = 0.50 × should_score + 0.35 × should_not_score + 0.15 × latency_score
```

- **should_score** — fraction of "agent should do X" criteria passed
- **should_not_score** — fraction of "agent should NOT do X" criteria passed
- **latency_score** — 1.0 (text mode, no voice latency in evals)

A change is **kept** if it improves the score by > 0.005. If the score is unchanged but the prompt got shorter, that's also a keep (simpler is better).

## What Gets Tested

The eval judge (Claude Sonnet) checks for:

- **Tool syntax** — did the agent use correct `amd verify --last` flags?
- **Skill reading** — did it read the skill file before acting?
- **Hallucination** — did it make up addresses, doctors, or insurance info?
- **Question stacking** — did it ask multiple questions in one turn?
- **Performative filler** — "Absolutely!", "Great question!"
- **Boundaries** — did it refuse medical advice and stay in scope?
- **Flow compliance** — one thing at a time, confirm before commit
- **Error recovery** — graceful handling when tools fail

## Output Files

```
eval/results/
├── research.json              # Full experiment log (scores, proposals, keep/discard)
├── report.html                # Interactive charts (open in browser)
├── workflows.json             # Workflow eval results with transcripts
├── extracted-scenarios.json   # Scenarios generated from production failures
├── best_SOUL.md               # Best SOUL.md from research run
├── best_VOICE.md              # Best VOICE.md from research run
└── best_skills_*              # Best skill files from research run
```

## The Path to Production-Grade

### Phase 1: Baseline (where you start)
- Run `workflows` to see which flows pass/fail
- Run `extract --days 30` to find real failure patterns
- Identify the biggest gaps: tool errors? hallucinations? flow issues?

### Phase 2: Iterate (weekly cycle)
1. `extract --days 7` — pull last week's failures
2. `research --from-extracted --max 15` — iterate on prompt
3. Review the HTML report — which changes stuck? which were discarded?
4. Commit + deploy the best prompt
5. Monitor production calls for the next week

### Phase 3: Harden (ongoing)
- Add new workflow scenarios as you discover edge cases
- Track scores over time — are they trending up?
- Watch for regressions when you change models
- Use the failure type breakdown to prioritize work:
  - `TOOL_ERROR` → fix skill instructions or CLI
  - `HALLUCINATION` → add info to knowledge-base skill
  - `LOOP` → strengthen "one thing at a time" in SOUL.md
  - `TRANSFER_NEEDED` → expand what the agent can handle

### Phase 4: Continuous learning
- Set up a cron job or CI step: `extract --days 7` → `research --from-extracted --max 5`
- Auto-generate a report, review the diff, deploy if scores improved
- The agent learns from every failed call without manual intervention

## Tips

- **Start small.** 5 scenarios × 3 experiments to validate the loop works, then scale up.
- **Real > synthetic.** `--from-extracted` scenarios are always more valuable than generated ones because they reflect actual caller behavior.
- **Watch the discards.** If every experiment is discarded, the prompt might be at a local maximum — try a different model or restructure the skills.
- **Shorter prompts win.** If two prompts score the same, the shorter one is better. Less to confuse the model.
- **Model matters more than prompt.** If a model can't follow tool syntax after 10 experiments of prompt tuning, switch models.
