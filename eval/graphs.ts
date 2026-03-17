// eval/graphs.ts — Generate HTML report with interactive charts
// Opens in any browser. Uses Chart.js from CDN — no native deps.

import { writeFileSync } from "fs";
import { join } from "path";
import type { ExperimentRecord } from "./types.js";

export function generateReport(
  history: ExperimentRecord[],
  outputDir: string,
): string {
  const experiments = history.filter((h) => h.number > 0);
  const baseline = history.find((h) => h.number === 0);
  const kept = history.filter((h) => h.status === "keep" || h.status === "baseline");

  // Data for score progression chart
  const allNumbers = history.map((h) => h.number);
  const allScores = history.map((h) => h.score);
  const keptNumbers = kept.map((h) => h.number);
  const keptScores = kept.map((h) => h.score);
  const discarded = experiments.filter((h) => h.status === "discard");
  const discardedNumbers = discarded.map((h) => h.number);
  const discardedScores = discarded.map((h) => h.score);

  // Running best line
  let best = baseline?.score ?? 0;
  const runningBest = history.map((h) => {
    if (h.status === "keep" || h.status === "baseline") best = Math.max(best, h.score);
    return best;
  });

  // Data for keep/discard bar chart
  const expDeltas = experiments.map((h) => ({
    label: `exp ${h.number}`,
    delta: h.score - h.baselineScore,
    description: h.description,
    status: h.status,
  }));

  // Data for prompt evolution (keeps only)
  const keptEvolution = kept.map((h) => ({
    label: `exp ${h.number}`,
    chars: h.promptChars,
    score: h.score,
  }));

  // Failure mode summary
  const failureCounts: Record<string, number> = {};
  for (const h of history) {
    for (const r of h.evalResults) {
      for (const fm of r.failureModes) {
        failureCounts[fm] = (failureCounts[fm] || 0) + 1;
      }
    }
  }
  const topFailures = Object.entries(failureCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>AutoVoiceEvals Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; padding: 20px; }
  h1 { color: #58a6ff; text-align: center; }
  h2 { color: #8b949e; margin-top: 40px; }
  .chart-container { background: #161b22; border-radius: 8px; padding: 20px; margin: 20px 0; max-width: 900px; margin-left: auto; margin-right: auto; }
  canvas { max-height: 400px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; max-width: 900px; margin: 20px auto; }
  .stat { background: #161b22; border-radius: 8px; padding: 16px; text-align: center; }
  .stat .value { font-size: 2em; font-weight: bold; color: #58a6ff; }
  .stat .label { color: #8b949e; font-size: 0.85em; margin-top: 4px; }
  .failures { max-width: 900px; margin: 20px auto; }
  .failure-bar { display: flex; align-items: center; margin: 4px 0; }
  .failure-bar .name { width: 200px; text-align: right; padding-right: 12px; font-size: 0.85em; color: #8b949e; }
  .failure-bar .bar { background: #da3633; height: 20px; border-radius: 3px; min-width: 4px; }
  .failure-bar .count { padding-left: 8px; font-size: 0.85em; }
  table { width: 100%; max-width: 900px; margin: 20px auto; border-collapse: collapse; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #21262d; font-size: 0.85em; }
  th { color: #8b949e; }
  .keep { color: #3fb950; }
  .discard { color: #da3633; }
</style>
</head>
<body>
<h1>AutoVoiceEvals Report</h1>
<p style="text-align:center;color:#8b949e">${experiments.length} Experiments, ${kept.length - 1} Kept Improvements</p>

<div class="stats">
  <div class="stat"><div class="value">${(baseline?.score ?? 0).toFixed(3)}</div><div class="label">Baseline Score</div></div>
  <div class="stat"><div class="value">${Math.max(...allScores).toFixed(3)}</div><div class="label">Best Score</div></div>
  <div class="stat"><div class="value">${experiments.length}</div><div class="label">Experiments</div></div>
  <div class="stat"><div class="value">${kept.length - 1}</div><div class="label">Kept</div></div>
  <div class="stat"><div class="value">${topFailures.length}</div><div class="label">Failure Modes</div></div>
</div>

<div class="chart-container">
  <h2 style="margin-top:0">Score Progression</h2>
  <canvas id="progressionChart"></canvas>
</div>

<div class="chart-container">
  <h2 style="margin-top:0">Keep / Discard Decisions</h2>
  <canvas id="deltaChart"></canvas>
</div>

<div class="chart-container">
  <h2 style="margin-top:0">Prompt Evolution (keeps only)</h2>
  <canvas id="evolutionChart"></canvas>
</div>

<div class="failures">
  <h2>Top Failure Modes</h2>
  ${topFailures.map(([name, count]) => {
    const maxCount = topFailures[0][1];
    const width = Math.round((count / maxCount) * 300);
    return `<div class="failure-bar"><span class="name">${name}</span><div class="bar" style="width:${width}px"></div><span class="count">${count}</span></div>`;
  }).join("\n  ")}
</div>

<h2 style="max-width:900px;margin:40px auto 10px">Experiment Log</h2>
<table>
  <tr><th>#</th><th>Status</th><th>Score</th><th>Delta</th><th>Chars</th><th>Description</th></tr>
  ${history.map((h) => {
    const delta = h.number === 0 ? "—" : (h.score - h.baselineScore >= 0 ? "+" : "") + (h.score - h.baselineScore).toFixed(3);
    const cls = h.status === "keep" || h.status === "baseline" ? "keep" : "discard";
    return `<tr><td>${h.number}</td><td class="${cls}">${h.status}</td><td>${h.score.toFixed(3)}</td><td>${delta}</td><td>${h.promptChars}</td><td>${h.description.slice(0, 70)}</td></tr>`;
  }).join("\n  ")}
</table>

<script>
// Score Progression
new Chart(document.getElementById('progressionChart'), {
  type: 'line',
  data: {
    labels: ${JSON.stringify(allNumbers)},
    datasets: [
      { label: 'Running best', data: ${JSON.stringify(runningBest)}, borderColor: '#3fb950', backgroundColor: '#3fb95033', fill: true, stepped: true, pointRadius: 0 },
      { label: 'Kept', data: ${JSON.stringify(allNumbers.map((n, i) => kept.some(k => k.number === n) ? allScores[i] : null))}, borderColor: '#3fb950', backgroundColor: '#3fb950', pointRadius: 6, showLine: false },
      { label: 'Discarded', data: ${JSON.stringify(allNumbers.map((n, i) => discarded.some(d => d.number === n) ? allScores[i] : null))}, borderColor: '#8b949e', backgroundColor: '#8b949e', pointRadius: 5, showLine: false },
    ]
  },
  options: { responsive: true, scales: { y: { min: 0.6, max: 1.0, ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }, x: { title: { display: true, text: 'Experiment #', color: '#8b949e' }, ticks: { color: '#8b949e' }, grid: { color: '#21262d' } } }, plugins: { legend: { labels: { color: '#c9d1d9' } } } }
});

// Keep/Discard Bars
const deltaData = ${JSON.stringify(expDeltas)};
new Chart(document.getElementById('deltaChart'), {
  type: 'bar',
  data: {
    labels: deltaData.map(d => d.label),
    datasets: [{
      data: deltaData.map(d => d.delta),
      backgroundColor: deltaData.map(d => d.status === 'keep' ? '#3fb950' : '#da3633'),
    }]
  },
  options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: (ctx) => deltaData[ctx.dataIndex].description } } }, scales: { x: { title: { display: true, text: 'Score Delta', color: '#8b949e' }, ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }, y: { ticks: { color: '#8b949e' }, grid: { display: false } } } }
});

// Prompt Evolution
const evoData = ${JSON.stringify(keptEvolution)};
new Chart(document.getElementById('evolutionChart'), {
  type: 'bar',
  data: {
    labels: evoData.map(d => d.label),
    datasets: [
      { label: 'Prompt length', data: evoData.map(d => d.chars), backgroundColor: '#58a6ff88', yAxisID: 'y' },
      { label: 'Score', data: evoData.map(d => d.score), borderColor: '#da3633', backgroundColor: '#da3633', type: 'line', yAxisID: 'y1', pointRadius: 5 },
    ]
  },
  options: { responsive: true, scales: { y: { title: { display: true, text: 'Prompt length (chars)', color: '#58a6ff' }, ticks: { color: '#58a6ff' }, grid: { color: '#21262d' }, position: 'left' }, y1: { title: { display: true, text: 'Score', color: '#da3633' }, ticks: { color: '#da3633' }, grid: { display: false }, position: 'right', min: 0, max: 1 }, x: { title: { display: true, text: 'Kept Experiment', color: '#8b949e' }, ticks: { color: '#8b949e' }, grid: { display: false } } }, plugins: { legend: { labels: { color: '#c9d1d9' } } } }
});
</script>
</body>
</html>`;

  const reportPath = join(outputDir, "report.html");
  writeFileSync(reportPath, html);
  return reportPath;
}
