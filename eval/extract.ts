// eval/extract.ts — Extract failed calls from production DB and convert to eval scenarios
// Connects to the Postgres webhook events DB, pulls transcripts, classifies failures,
// and generates eval scenarios from real caller conversations.

import { callJson } from "./llm.js";
import type { Scenario, EvalConfig } from "./types.js";

const DATABASE_URL = process.env.DATABASE_URL || "";

const CLASSIFIER_SYSTEM = `You are a QA analyst reviewing voice agent call transcripts.
Identify failures, classify severity, and extract the caller's conversation turns.
You MUST respond with valid JSON only.`;

interface RawTranscript {
  conversationId: string;
  createdAt: string;
  summary: string;
  transcript: {
    role: string;
    message: string | null;
    tool_calls?: any[];
    tool_results?: any[];
    interrupted?: boolean;
  }[];
}

// --- DB query ---

async function queryDB(sql: string, params: any[] = []): Promise<any[]> {
  // Use pg dynamically to avoid hard dependency
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

// --- Pull recent transcripts ---

export async function pullRecentCalls(days = 7, limit = 50): Promise<RawTranscript[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const rows = await queryDB(`
    SELECT "conversationId", "createdAt",
      data->'analysis'->>'call_summary_title' as summary,
      data->'transcript' as transcript
    FROM "WebhookEvent"
    WHERE type = 'post_call_transcription'
      AND "createdAt" >= $1
      AND jsonb_typeof(data->'transcript') = 'array'
      AND jsonb_array_length(data->'transcript') >= 4
    ORDER BY "createdAt" DESC
    LIMIT $2
  `, [cutoff, limit]);

  return rows.map((r: any) => ({
    conversationId: r.conversationId,
    createdAt: r.createdAt,
    summary: r.summary || "Unknown",
    transcript: r.transcript,
  }));
}

// --- Build readable transcript ---

function formatTranscript(turns: RawTranscript["transcript"]): string {
  return turns.map((t) => {
    const msg = t.message || "";
    let line = `[${t.role}]${t.interrupted ? " [interrupted]" : ""} ${msg}`;
    if (t.tool_calls?.length) {
      for (const tc of t.tool_calls) {
        const name = tc.name || "unknown";
        const args = JSON.stringify(tc.params || tc.arguments || {}).slice(0, 100);
        line += `\n  [tool:${name}] ${args}`;
      }
    }
    if (t.tool_results?.length) {
      for (const tr of t.tool_results) {
        const result = JSON.stringify(tr.result || "").slice(0, 100);
        line += `\n  [result:${tr.name}] ${result}`;
      }
    }
    return line;
  }).join("\n");
}

// --- Classify a call for failures ---

interface ClassifiedCall {
  conversationId: string;
  createdAt: string;
  summary: string;
  transcript: string;
  callerTurns: string[];
  hasFailure: boolean;
  failureTypes: string[];
  severity: "none" | "low" | "medium" | "high" | "critical";
  failureDescription: string;
}

export async function classifyCalls(
  config: EvalConfig,
  calls: RawTranscript[],
): Promise<ClassifiedCall[]> {
  const results: ClassifiedCall[] = [];

  for (const call of calls) {
    const transcript = formatTranscript(call.transcript);
    const callerTurns = call.transcript
      .filter((t) => t.role === "user" && t.message)
      .map((t) => t.message!);

    // Skip very short calls
    if (callerTurns.length < 2) {
      results.push({
        conversationId: call.conversationId,
        createdAt: call.createdAt,
        summary: call.summary,
        transcript,
        callerTurns,
        hasFailure: false,
        failureTypes: [],
        severity: "none",
        failureDescription: "Too short to evaluate",
      });
      continue;
    }

    try {
      const classification = await callJson(
        config.anthropicApiKey,
        config.evalModel,
        CLASSIFIER_SYSTEM,
        `Analyze this voice agent call transcript for failures.

TRANSCRIPT:
${transcript.slice(0, 4000)}

Classify this call. Look for:
- Tool errors (wrong command syntax, failed tool calls)
- Hallucinated information (wrong address, made-up doctors, incorrect hours)
- Agent got stuck in a loop (repeating the same question)
- Caller had to repeat themselves 3+ times
- Caller asked to be transferred (agent couldn't help)
- Agent stacked multiple questions in one turn
- Agent used performative filler ("Absolutely!", "Great question!")
- Agent gave medical advice or went outside its scope
- Caller expressed frustration
- Agent didn't read skill files before using tools

Return JSON:
{
  "has_failure": true/false,
  "failure_types": ["HALLUCINATION", "TOOL_ERROR", "LOOP", "TRANSFER_NEEDED", etc],
  "severity": "none|low|medium|high|critical",
  "failure_description": "1-2 sentence summary of what went wrong",
  "key_moments": ["turn X: description of what happened"]
}`,
        1500,
      );

      results.push({
        conversationId: call.conversationId,
        createdAt: call.createdAt,
        summary: call.summary,
        transcript,
        callerTurns,
        hasFailure: classification.has_failure ?? false,
        failureTypes: classification.failure_types ?? [],
        severity: classification.severity ?? "none",
        failureDescription: classification.failure_description ?? "",
      });
    } catch (err) {
      results.push({
        conversationId: call.conversationId,
        createdAt: call.createdAt,
        summary: call.summary,
        transcript,
        callerTurns,
        hasFailure: false,
        failureTypes: ["CLASSIFICATION_ERROR"],
        severity: "none",
        failureDescription: `Classification failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  }

  return results;
}

// --- Convert failed calls to eval scenarios ---

export async function generateScenariosFromFailures(
  config: EvalConfig,
  failures: ClassifiedCall[],
): Promise<Scenario[]> {
  const scenarios: Scenario[] = [];

  // Filter out scenarios that are only about transfers/redirects — keep ones
  // that involve tool calls, scheduling, insurance, patient workflows
  const SKIP_PATTERNS = [
    /^(transfer|redirect|connect)/i,
    /just wants? (to be )?transfer/i,
    /pure transfer/i,
    /reorder.*eyewear/i,
    /returning.*call/i,
  ];

  const interesting = failures.filter((call) => {
    if (!call.hasFailure || call.callerTurns.length < 2) return false;

    // Keep if any failure type involves tools, registration, or workflow
    const hasToolIssue = call.failureTypes.some((ft) =>
      /TOOL|LOOP|HALLUCINATION|REGISTRATION|WORKFLOW|INCOMPLETE/i.test(ft),
    );
    if (hasToolIssue) return true;

    // Skip if the summary or description is purely about transferring
    const desc = `${call.summary} ${call.failureDescription}`.toLowerCase();
    if (SKIP_PATTERNS.some((p) => p.test(desc))) return false;

    // Keep everything else (insurance questions, scheduling issues, etc.)
    return true;
  });

  console.log(`  Filtered: ${failures.length} failures → ${interesting.length} interesting scenarios (skipped ${failures.length - interesting.length} transfer-only)`);

  for (let i = 0; i < interesting.length; i++) {
    const call = interesting[i];

    try {
      const scenario = await callJson(
        config.anthropicApiKey,
        config.evalModel,
        `You are a QA engineer converting real failed call transcripts into reproducible test scenarios.
Extract the caller's conversation flow and create evaluation criteria based on what went wrong.
You MUST respond with valid JSON only.`,
        `Convert this failed call into an eval scenario.

CALL SUMMARY: ${call.summary}
FAILURE: ${call.failureDescription}
FAILURE TYPES: ${JSON.stringify(call.failureTypes)}

TRANSCRIPT:
${call.transcript.slice(0, 3000)}

Create a test scenario that replays the caller's side of the conversation.
The agentShould criteria should test that the agent handles this correctly.
The agentShouldNot criteria should catch the specific failures that occurred.

Return JSON:
{
  "id": "PROD_${String(i + 1).padStart(3, "0")}",
  "personaName": "caller persona name based on the conversation",
  "personaBackground": "brief description",
  "difficulty": "A|B|C|D",
  "attackStrategy": "what this scenario tests based on the real failure",
  "callerScript": ["turn1", "turn2", ...],
  "agentShould": ["criterion1", ...],
  "agentShouldNot": ["criterion1", ...]
}`,
        2000,
      );

      if (scenario?.callerScript?.length) {
        scenarios.push(scenario);
      }
    } catch (err) {
      console.error(`  Failed to generate scenario from ${call.conversationId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return scenarios;
}

// --- Main: pull → classify → extract scenarios ---

export async function extractFromProduction(
  config: EvalConfig,
  days = 7,
  limit = 50,
): Promise<{ calls: ClassifiedCall[]; scenarios: Scenario[] }> {
  const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
  const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
  const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

  console.log(bold(cyan("\n══════════════════════════════════════")));
  console.log(bold(cyan("  Production Failure Extraction")));
  console.log(bold(cyan("══════════════════════════════════════\n")));

  // Pull calls
  console.log(`  Pulling calls from last ${days} days (limit ${limit})...`);
  const calls = await pullRecentCalls(days, limit);
  console.log(`  Found ${calls.length} calls with transcripts\n`);

  if (!calls.length) {
    return { calls: [], scenarios: [] };
  }

  // Classify
  console.log(`  Classifying calls for failures...`);
  const classified = await classifyCalls(config, calls);

  const failures = classified.filter((c) => c.hasFailure);
  const bySeverity = {
    critical: failures.filter((c) => c.severity === "critical").length,
    high: failures.filter((c) => c.severity === "high").length,
    medium: failures.filter((c) => c.severity === "medium").length,
    low: failures.filter((c) => c.severity === "low").length,
  };

  console.log(`\n  Results:`);
  console.log(`    Total calls:    ${classified.length}`);
  console.log(`    With failures:  ${red(String(failures.length))} (${Math.round(failures.length / classified.length * 100)}%)`);
  console.log(`    Critical:       ${bySeverity.critical}`);
  console.log(`    High:           ${bySeverity.high}`);
  console.log(`    Medium:         ${bySeverity.medium}`);
  console.log(`    Low:            ${bySeverity.low}`);

  // Show failures
  if (failures.length) {
    console.log(`\n  Failures:`);
    for (const f of failures.sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };
      return (order[a.severity] ?? 4) - (order[b.severity] ?? 4);
    })) {
      const sev = f.severity === "critical" || f.severity === "high" ? red(f.severity) : f.severity;
      console.log(`    [${sev}] ${f.summary} ${dim(`(${f.conversationId.slice(0, 15)}...)`)}`);
      console.log(`      ${dim(f.failureDescription)}`);
    }
  }

  // Failure type breakdown
  const typeCounts: Record<string, number> = {};
  for (const f of failures) {
    for (const ft of f.failureTypes) {
      typeCounts[ft] = (typeCounts[ft] || 0) + 1;
    }
  }
  if (Object.keys(typeCounts).length) {
    console.log(`\n  Failure types:`);
    for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${type}: ${count}`);
    }
  }

  // Generate scenarios from failures
  console.log(`\n  Generating eval scenarios from ${failures.length} failures...`);
  const scenarios = await generateScenariosFromFailures(config, failures);
  console.log(`  Generated ${green(String(scenarios.length))} scenarios\n`);

  for (const sc of scenarios) {
    console.log(`    ${dim(sc.id)} ${sc.personaName} — ${sc.attackStrategy.slice(0, 60)}`);
  }

  return { calls: classified, scenarios };
}
