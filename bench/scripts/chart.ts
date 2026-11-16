// PROMPTS 162: bench/learning.svg from bench/data/learning.json. A static SVG with no dependencies that reads on light and dark
// GitHub: x = share of the simulated train events learned from, y = strict file recall on the TEST split, with V3 (no learning)
// as a dashed baseline. Labelled "simulated outcomes" in the chart itself.
//   pnpm tsx bench/scripts/chart.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Curve {
  n: number;
  budget: number;
  steps: { fraction: number; events: number; strict: number; runId: string }[];
}

export function learningSvg(curve: Curve, baseline: number): string {
  const W = 640;
  const H = 320;
  const m = { l: 56, r: 24, t: 40, b: 52 };
  const values = [...curve.steps.map((s) => s.strict), baseline];
  const lo = Math.max(0, Math.floor((Math.min(...values) - 0.03) * 20) / 20);
  const hi = Math.min(1, Math.ceil((Math.max(...values) + 0.03) * 20) / 20);
  const x = (f: number): number => m.l + f * (W - m.l - m.r);
  const y = (v: number): number => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const ticks: string[] = [];
  for (let v = lo; v <= hi + 1e-9; v += 0.05) {
    ticks.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#8884" stroke-width="1"/><text x="${m.l - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${Math.round(v * 100)}%</text>`);
  }
  for (const s of curve.steps) ticks.push(`<text x="${x(s.fraction).toFixed(1)}" y="${H - m.b + 18}" text-anchor="middle">${Math.round(s.fraction * 100)}%</text>`);
  const path = curve.steps.map((s, i) => `${i ? 'L' : 'M'}${x(s.fraction).toFixed(1)},${y(s.strict).toFixed(1)}`).join(' ');
  const dots = curve.steps
    .map((s) => `<circle cx="${x(s.fraction).toFixed(1)}" cy="${y(s.strict).toFixed(1)}" r="4" fill="#FF571A"><title>${Math.round(s.fraction * 100)}% of events (${s.events}): ${(s.strict * 100).toFixed(1)}% · run ${s.runId}</title></circle>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, sans-serif" font-size="12" fill="#888">
<title>Click learning curve: V5 strict file recall on the test split vs share of simulated train events learned from</title>
<text x="${m.l}" y="20" font-size="14" font-weight="600" fill="#888">Learning curve (simulated outcomes) · test split, n=${curve.n}, ${curve.budget / 1000}k tokens</text>
${ticks.join('\n')}
<line x1="${m.l}" x2="${W - m.r}" y1="${y(baseline).toFixed(1)}" y2="${y(baseline).toFixed(1)}" stroke="#888" stroke-width="1.5" stroke-dasharray="6 5"/>
<text x="${W - m.r}" y="${(y(baseline) - 6).toFixed(1)}" text-anchor="end">V3, no learning (${(baseline * 100).toFixed(1)}%)</text>
<path d="${path}" fill="none" stroke="#FF571A" stroke-width="2.5"/>
${dots}
<text x="${(m.l + W - m.r) / 2}" y="${H - 10}" text-anchor="middle">share of train events learned from</text>
</svg>
`;
}

function main(): void {
  const curve = JSON.parse(readFileSync(resolve('bench/data/learning.json'), 'utf8')) as Curve;
  const rows = readFileSync(resolve('bench/results.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as { variant: string; budget: number; split: string; ts: string; metrics: { recallStrict: number } });
  const v3 = rows.filter((r) => r.variant === 'V3' && r.budget === curve.budget && r.split === 'test').sort((a, b) => b.ts.localeCompare(a.ts))[0];
  if (!v3) throw new Error('no V3 test row at this budget');
  writeFileSync(resolve('bench/learning.svg'), learningSvg(curve, v3.metrics.recallStrict));
  console.log('bench/learning.svg written');
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) main();
