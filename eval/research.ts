// eval/research.ts — Autoresearch loop: generate scenarios, test, propose changes, keep/revert

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import type { AgentOptions } from "../src/agent.js";
import type { Scenario, EvalResult, ExperimentRecord, EvalConfig } from "./types.js";
import { runConversation } from "./runner.js";
import { generateScenarios, evaluate, compositeScore, proposeChange } from "./evaluator.js";
import { generateReport } from "./graphs.js";

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function bar(score: number, width = 20): string {
  const filled = Math.round(score * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// --- File backup/restore ---

function backupFiles(cwd: string, files: Record<string, string>): Record<string, string> {
  const backup: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    backup[name] = content;
  }
  return backup;
}

function applyFiles(cwd: string, files: Record<string, string>): void {
  const workspace = join(cwd, "workspace");
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(workspace, name);
    writeFileSync(filePath, content);
  }
}

function loadWorkspaceFiles(cwd: string): Record<string, string> {
  const files: Record<string, string> = {};
  const workspace = join(cwd, "workspace");

  for (const name of ["SOUL.md", "VOICE.md"]) {
    try {
      files[name] = readFileSync(join(workspace, name), "utf-8");
    } catch {}
  }

  const skillsDir = join(workspace, "skills");
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const instrPath = join(skillsDir, entry.name, "SKILL.md");
      try {
        files[`skills/${entry.name}/SKILL.md`] = readFileSync(instrPath, "utf-8");
      } catch {}
    }
  }
  return files;
}

// --- Run all scenarios ---

async function runEvalSuite(
  config: EvalConfig,
  agentOptions: AgentOptions,
  scenarios: Scenario[],
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];

  for (let i = 0; i < scenarios.length; i++) {
    const sc = scenarios[i];
    process.stdout.write(`    ${dim(`[${i + 1}/${scenarios.length}]`)} ${sc.personaName}... `);

    try {
      const conv = await runConversation(agentOptions, sc, config.maxTurns);
      const evalResult = await evaluate(config, conv.transcript, sc);

      const status = evalResult.passed ? green("PASS") : red("FAIL");
      const scoreBar = bar(evalResult.score);
      console.log(`${status} ${evalResult.score.toFixed(3)} [${scoreBar}] CSAT=${evalResult.csatScore} ${sc.attackStrategy.slice(0, 40)}`);

      results.push(evalResult);
    } catch (err) {
      console.log(red("ERROR") + ` ${err instanceof Error ? err.message : err}`);
      results.push({
        scenarioId: sc.id,
        score: 0,
        csatScore: 0,
        passed: false,
        summary: `Runner error: ${err instanceof Error ? err.message : err}`,
        shouldResults: [],
        shouldNotResults: [],
        failureModes: ["RUNNER_ERROR"],
        issues: [],
      });
    }
  }

  return results;
}

function avgScore(results: EvalResult[]): number {
  if (!results.length) return 0;
  return results.reduce((s, r) => s + r.score, 0) / results.length;
}

function avgCsat(results: EvalResult[]): number {
  if (!results.length) return 0;
  return Math.round(results.reduce((s, r) => s + r.csatScore, 0) / results.length);
}

// --- Main research loop ---

export async function runResearch(
  config: EvalConfig,
  agentOptions: AgentOptions,
  cwd: string,
): Promise<void> {
  const resultsDir = join(cwd, "eval", "results");
  mkdirSync(resultsDir, { recursive: true });

  console.log(bold(cyan("\n══════════════════════════════════════")));
  console.log(bold(cyan("  AutoVoiceEvals — Research Mode")));
  console.log(bold(cyan("══════════════════════════════════════\n")));

  // Step 1: Generate eval scenarios
  console.log(bold("  Generating eval scenarios...\n"));
  const scenarios = await generateScenarios(config, cwd, config.numScenarios, 1);
  console.log(`  Generated ${scenarios.length} scenarios:\n`);
  for (const sc of scenarios) {
    console.log(`    ${dim(sc.id)} ${sc.personaName} — ${sc.attackStrategy.slice(0, 50)}`);
  }
  console.log("");

  // Step 2: Run baseline
  console.log(bold("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  console.log(bold("  BASELINE"));
  console.log(bold("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));

  const baselineResults = await runEvalSuite(config, agentOptions, scenarios);
  const baselineScore = avgScore(baselineResults);
  const baselineOriginalFiles = loadWorkspaceFiles(cwd);
  const promptChars = Object.values(baselineOriginalFiles).reduce((s, c) => s + c.length, 0);

  console.log(`\n  ${bold("Baseline:")} score=${baselineScore.toFixed(3)} CSAT=${avgCsat(baselineResults)} pass=${baselineResults.filter((r) => r.passed).length}/${baselineResults.length} prompt=${promptChars} chars\n`);

  const history: ExperimentRecord[] = [{
    number: 0,
    description: "baseline",
    changeType: "none",
    score: baselineScore,
    baselineScore,
    status: "baseline",
    promptChars,
    evalResults: baselineResults,
  }];

  let bestScore = baselineScore;
  let bestFiles = { ...baselineOriginalFiles };
  const allFailures = new Set<string>();
  for (const r of baselineResults) {
    for (const fm of r.failureModes) allFailures.add(fm);
  }

  // Step 3: Research loop
  const maxExp = config.maxExperiments || Infinity;

  for (let exp = 1; exp <= maxExp; exp++) {
    console.log(bold("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
    console.log(bold(`  EXPERIMENT ${exp}`));
    console.log(bold("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));

    // Propose a change
    const lastResults = history[history.length - 1].evalResults;
    const proposal = await proposeChange(config, cwd, lastResults, history, [...allFailures]);

    if (!proposal) {
      console.log(red("  No change proposed, skipping.\n"));
      continue;
    }

    console.log(`  ${dim(`[${proposal.changeType}]`)} ${proposal.description}`);
    const changedFile = Object.keys(proposal.files)[0];
    const newContent = Object.values(proposal.files)[0];
    const oldLen = bestFiles[changedFile]?.length ?? 0;
    console.log(`  ${dim(`${changedFile}: ${oldLen} → ${newContent.length} chars`)}\n`);

    // Apply change
    applyFiles(cwd, proposal.files);

    // Run eval suite
    const expResults = await runEvalSuite(config, agentOptions, scenarios);
    const expScore = avgScore(expResults);
    const newPromptChars = Object.values({ ...bestFiles, ...proposal.files }).reduce((s, c) => s + c.length, 0);

    for (const r of expResults) {
      for (const fm of r.failureModes) allFailures.add(fm);
    }

    // Keep or revert
    const delta = expScore - bestScore;
    const improved = delta > config.improvementThreshold;
    const sameButShorter = Math.abs(delta) <= config.improvementThreshold && newPromptChars < promptChars;
    const keep = improved || sameButShorter;

    const status = keep ? "keep" : "discard";
    const statusLabel = keep ? green("→ KEEP") : red("→ DISCARD");
    const deltaStr = delta >= 0 ? `+${delta.toFixed(3)}` : delta.toFixed(3);

    console.log(`\n  Result: score=${expScore.toFixed(3)} (${deltaStr}) CSAT=${avgCsat(expResults)} pass=${expResults.filter((r) => r.passed).length}/${expResults.length}`);
    console.log(`  ${statusLabel}  (best=${bestScore.toFixed(3)}, prompt=${newPromptChars} chars)\n`);

    if (keep) {
      bestScore = expScore;
      bestFiles = { ...bestFiles, ...proposal.files };
    } else {
      // Revert
      applyFiles(cwd, bestFiles);
    }

    history.push({
      number: exp,
      description: proposal.description,
      changeType: proposal.changeType as any,
      score: expScore,
      baselineScore,
      status,
      promptChars: newPromptChars,
      evalResults: expResults,
    });

    // Save progress
    const logPath = join(resultsDir, "research.json");
    writeFileSync(logPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      baselineScore,
      bestScore,
      totalExperiments: exp,
      history: history.map((h) => ({
        number: h.number,
        description: h.description,
        changeType: h.changeType,
        score: h.score,
        status: h.status,
        promptChars: h.promptChars,
      })),
      failureModes: [...allFailures],
    }, null, 2));
  }

  // Final report
  console.log(bold(cyan("\n══════════════════════════════════════")));
  console.log(bold(cyan("  RESEARCH COMPLETE")));
  console.log(bold(cyan("══════════════════════════════════════\n")));
  console.log(`  Baseline:  ${baselineScore.toFixed(3)}`);
  console.log(`  Best:      ${bestScore.toFixed(3)} (${bestScore > baselineScore ? green(`+${(bestScore - baselineScore).toFixed(3)}`) : "no change"})`);
  console.log(`  Experiments: ${history.length - 1} (${history.filter((h) => h.status === "keep").length - 1} kept)`);
  console.log(`  Failure modes found: ${allFailures.size}`);
  console.log(`\n  Results saved to: eval/results/research.json\n`);

  // Save best files
  for (const [name, content] of Object.entries(bestFiles)) {
    writeFileSync(join(resultsDir, `best_${name.replace(/\//g, "_")}`), content);
  }

  // Generate HTML report with charts
  const reportPath = generateReport(history, resultsDir);
  console.log(`  Report: ${reportPath}\n`);
}
