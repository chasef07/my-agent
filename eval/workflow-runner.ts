// eval/workflow-runner.ts — Run end-to-end workflow scenarios and produce a detailed report
// Unlike the research loop, this doesn't modify prompts — it just tests and reports.

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { AgentOptions } from "../src/agent.js";
import type { Scenario, EvalResult, EvalConfig } from "./types.js";
import { runConversation } from "./runner.js";
import { evaluate } from "./evaluator.js";
import { generateReport } from "./graphs.js";

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function bar(score: number, width = 20): string {
  const filled = Math.round(score * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export async function runWorkflowEval(
  config: EvalConfig,
  agentOptions: AgentOptions,
  cwd: string,
  scenarios: Scenario[],
): Promise<void> {
  const resultsDir = join(cwd, "eval", "results");
  mkdirSync(resultsDir, { recursive: true });

  console.log(bold(cyan("\n══════════════════════════════════════")));
  console.log(bold(cyan("  Workflow Eval — End-to-End Flows")));
  console.log(bold(cyan("══════════════════════════════════════\n")));
  console.log(`  Scenarios: ${scenarios.length}`);
  console.log(`  Agent model: ${agentOptions.model.id}`);
  console.log(`  Judge model: ${config.evalModel}\n`);

  const results: {
    scenario: Scenario;
    transcript: string;
    toolCalls: { name: string; args: any; result?: string; isError: boolean }[];
    eval: EvalResult;
  }[] = [];

  for (let i = 0; i < scenarios.length; i++) {
    const sc = scenarios[i];
    console.log(bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
    console.log(bold(`  ${sc.id}: ${sc.personaName}`));
    console.log(dim(`  ${sc.attackStrategy}`));
    console.log(bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));

    try {
      // Run the conversation
      const conv = await runConversation(agentOptions, sc, config.maxTurns);

      // Print transcript
      for (const turn of conv.turns) {
        if (turn.role === "caller") {
          console.log(green(`  [caller]`) + ` "${turn.text}"`);
        } else {
          console.log(cyan(`  [agent]`) + ` "${turn.text.slice(0, 150)}${turn.text.length > 150 ? "..." : ""}"`);
          if (turn.toolCalls?.length) {
            for (const tc of turn.toolCalls) {
              const status = tc.isError ? red("ERR") : green("ok");
              const args = typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args);
              console.log(yellow(`    [tool:${tc.name}]`) + ` ${status} ${dim(`(${tc.durationMs}ms)`)} ${dim(args.slice(0, 100))}`);
              if (tc.result) {
                console.log(dim(`      → ${tc.result.slice(0, 120)}`));
              }
            }
          }
        }
      }

      // Collect all tool calls from agent turns
      const allToolCalls = conv.turns
        .filter((t) => t.toolCalls?.length)
        .flatMap((t) => t.toolCalls!);

      // Judge
      console.log(dim(`\n  Evaluating...`));
      const evalResult = await evaluate(config, conv.transcript, sc);

      const status = evalResult.passed ? green("PASS") : red("FAIL");
      console.log(`\n  ${status} ${evalResult.score.toFixed(3)} [${bar(evalResult.score)}] CSAT=${evalResult.csatScore}`);
      console.log(dim(`  ${evalResult.summary}`));

      // Print should/shouldn't results
      if (evalResult.shouldResults.length) {
        console.log(dim(`\n  Should:`));
        for (const r of evalResult.shouldResults) {
          const icon = r.passed ? green("✓") : red("✗");
          console.log(`    ${icon} ${r.criterion.slice(0, 80)}`);
          if (!r.passed && r.reasoning) {
            console.log(dim(`      → ${r.reasoning.slice(0, 100)}`));
          }
        }
      }
      if (evalResult.shouldNotResults.length) {
        console.log(dim(`\n  Should NOT:`));
        for (const r of evalResult.shouldNotResults) {
          const icon = r.passed ? green("✓") : red("✗");
          console.log(`    ${icon} ${r.criterion.slice(0, 80)}`);
          if (!r.passed && r.reasoning) {
            console.log(dim(`      → ${r.reasoning.slice(0, 100)}`));
          }
        }
      }

      console.log("");

      results.push({
        scenario: sc,
        transcript: conv.transcript,
        toolCalls: allToolCalls,
        eval: evalResult,
      });
    } catch (err) {
      console.error(red(`  ERROR: ${err instanceof Error ? err.message : err}\n`));
      results.push({
        scenario: sc,
        transcript: "",
        toolCalls: [],
        eval: {
          scenarioId: sc.id,
          score: 0,
          csatScore: 0,
          passed: false,
          summary: `Runner error: ${err instanceof Error ? err.message : err}`,
          shouldResults: [],
          shouldNotResults: [],
          failureModes: ["RUNNER_ERROR"],
          issues: [],
        },
      });
    }
  }

  // Summary
  const passed = results.filter((r) => r.eval.passed).length;
  const avgScore = results.reduce((s, r) => s + r.eval.score, 0) / results.length;
  const avgCsat = Math.round(results.reduce((s, r) => s + r.eval.csatScore, 0) / results.length);
  const totalToolCalls = results.reduce((s, r) => s + r.toolCalls.length, 0);
  const toolErrors = results.reduce((s, r) => s + r.toolCalls.filter((tc) => tc.isError).length, 0);

  // Tool call breakdown
  const toolCounts: Record<string, { total: number; errors: number }> = {};
  for (const r of results) {
    for (const tc of r.toolCalls) {
      if (!toolCounts[tc.name]) toolCounts[tc.name] = { total: 0, errors: 0 };
      toolCounts[tc.name].total++;
      if (tc.isError) toolCounts[tc.name].errors++;
    }
  }

  console.log(bold(cyan("\n══════════════════════════════════════")));
  console.log(bold(cyan("  WORKFLOW EVAL SUMMARY")));
  console.log(bold(cyan("══════════════════════════════════════\n")));
  console.log(`  Pass rate:    ${passed}/${results.length} (${Math.round(passed / results.length * 100)}%)`);
  console.log(`  Avg score:    ${avgScore.toFixed(3)}`);
  console.log(`  Avg CSAT:     ${avgCsat}`);
  console.log(`  Tool calls:   ${totalToolCalls} total, ${toolErrors} errors`);

  if (Object.keys(toolCounts).length) {
    console.log(`\n  Tool breakdown:`);
    for (const [name, counts] of Object.entries(toolCounts).sort((a, b) => b[1].total - a[1].total)) {
      const errStr = counts.errors > 0 ? red(` (${counts.errors} errors)`) : "";
      console.log(`    ${name}: ${counts.total} calls${errStr}`);
    }
  }

  // Per-scenario summary
  console.log(`\n  Per scenario:`);
  for (const r of results) {
    const icon = r.eval.passed ? green("✓") : red("✗");
    const tools = r.toolCalls.length ? dim(` | ${r.toolCalls.map(tc => tc.name).join(", ")}`) : "";
    console.log(`    ${icon} ${r.scenario.id} ${r.scenario.personaName} — ${r.eval.score.toFixed(3)}${tools}`);
  }

  // Failure modes
  const allFailures = new Set<string>();
  for (const r of results) {
    for (const fm of r.eval.failureModes) allFailures.add(fm);
  }
  if (allFailures.size) {
    console.log(`\n  Failure modes (${allFailures.size}):`);
    for (const fm of [...allFailures].sort()) {
      console.log(`    - ${fm}`);
    }
  }

  // Save detailed results
  const report = {
    timestamp: new Date().toISOString(),
    model: agentOptions.model.id,
    summary: { passed, total: results.length, avgScore, avgCsat, totalToolCalls, toolErrors },
    toolBreakdown: toolCounts,
    failureModes: [...allFailures],
    scenarios: results.map((r) => ({
      id: r.scenario.id,
      name: r.scenario.personaName,
      strategy: r.scenario.attackStrategy,
      score: r.eval.score,
      csatScore: r.eval.csatScore,
      passed: r.eval.passed,
      summary: r.eval.summary,
      toolCalls: r.toolCalls,
      shouldResults: r.eval.shouldResults,
      shouldNotResults: r.eval.shouldNotResults,
      failureModes: r.eval.failureModes,
      transcript: r.transcript,
    })),
  };

  const reportPath = join(resultsDir, "workflows.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n  Results saved to: ${reportPath}\n`);
}
