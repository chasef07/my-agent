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
    await runResearch(evalConfig, agentOptions, cwd);
  } else if (mode === "workflows") {
    await runWorkflowEval(evalConfig, agentOptions, cwd, workflowScenarios);
  } else {
    console.error(`Unknown mode: ${mode}. Use: research | workflows`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
