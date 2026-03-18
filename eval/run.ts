#!/usr/bin/env npx tsx
// eval/run.ts — CLI entry point for the eval system
// Usage:
//   npx tsx eval/run.ts research        # autoresearch loop
//   npx tsx eval/run.ts research --max 5 # stop after 5 experiments

import { loadConfig, getApiKey, createModel } from "../src/config.js";
import type { EvalConfig } from "./types.js";
import { runResearch } from "./research.js";
import { workflowScenarios } from "./workflows.js";
import { runWorkflowEval } from "./workflow-runner.js";
import { extractFromProduction } from "./extract.js";

const cwd = process.cwd();
const mode = process.argv[2] ?? "research";
const maxFlag = process.argv.indexOf("--max");
const maxExperiments = maxFlag !== -1 ? parseInt(process.argv[maxFlag + 1], 10) : 10;
const numScenarios = (() => {
  const idx = process.argv.indexOf("--scenarios");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 5;
})();

async function main() {
  // Load agent config (same as the agent uses)
  const config = loadConfig();
  const apiKey = getApiKey(config);
  const model = createModel(config);

  // Eval config
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    console.error("Set ANTHROPIC_API_KEY environment variable (for eval judge/generator)");
    process.exit(1);
  }

  const evalConfig: EvalConfig = {
    anthropicApiKey,
    evalModel: process.env.EVAL_MODEL ?? "claude-sonnet-4-20250514",
    numScenarios,
    maxExperiments,
    maxTurns: 12,
    improvementThreshold: 0.005,
    scoring: {
      shouldWeight: 0.50,
      shouldNotWeight: 0.35,
      latencyWeight: 0.15,
      latencyThresholdMs: 3000,
    },
  };

  const agentOptions = { model, apiKey, cwd };

  console.log(`\n  Agent model: ${model.id}`);
  console.log(`  Judge model: ${evalConfig.evalModel}`);
  console.log(`  Scenarios: ${evalConfig.numScenarios}`);
  console.log(`  Max experiments: ${evalConfig.maxExperiments}`);

  if (mode === "research") {
    let preloaded: undefined | any[];
    if (process.argv.includes("--from-extracted")) {
      const { readFileSync, existsSync } = await import("fs");
      const { join } = await import("path");
      const extractedPath = join(cwd, "eval", "results", "extracted-scenarios.json");
      if (existsSync(extractedPath)) {
        preloaded = JSON.parse(readFileSync(extractedPath, "utf-8"));
        console.log(`  Loaded ${preloaded!.length} scenarios from production failures`);
      } else {
        console.error(`  No extracted scenarios found. Run: npx tsx eval/run.ts extract --days 7`);
        process.exit(1);
      }
    }
    await runResearch(evalConfig, agentOptions, cwd, preloaded);
  } else if (mode === "workflows") {
    await runWorkflowEval(evalConfig, agentOptions, cwd, workflowScenarios);
  } else if (mode === "extract") {
    // Pull production failures and optionally run them as evals
    const days = (() => { const i = process.argv.indexOf("--days"); return i !== -1 ? parseInt(process.argv[i + 1], 10) : 7; })();
    const { calls, scenarios } = await extractFromProduction(evalConfig, days, 30);

    if (scenarios.length && process.argv.includes("--run")) {
      console.log("\n  Running extracted scenarios as workflow eval...\n");
      await runWorkflowEval(evalConfig, agentOptions, cwd, scenarios);
    } else if (scenarios.length) {
      console.log(`\n  To run these scenarios: add --run flag`);
      // Save scenarios for later use
      const { writeFileSync } = await import("fs");
      const { join } = await import("path");
      const outPath = join(cwd, "eval", "results", "extracted-scenarios.json");
      writeFileSync(outPath, JSON.stringify(scenarios, null, 2));
      console.log(`  Saved to: ${outPath}\n`);
    }
  } else {
    console.error(`Unknown mode: ${mode}. Use: research | workflows | extract`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
