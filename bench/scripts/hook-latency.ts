// PROMPTS 180: the hook latency row. 20 real prompts (the held-out task texts) through the installed, bundled prompt hook
// (dist/hooks/prompt.js), run the way Claude Code runs it: a fresh node process per prompt, JSON on stdin, cwd = the repo.
// Wall clock from process start to exit, p50 / p95 / max, plus how many prompts got context. Appends one `latency` row to
// bench/results.jsonl. Needs the bench repo's daemon running (any `click context` starts it).
//   pnpm tsx bench/scripts/hook-latency.ts [--n 20]

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { percentile } from '../src/metrics.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
const mainRoot = git.status === 0 ? dirname(git.stdout.trim()) : root;
const repo = join(mainRoot, 'bench', 'repo');
const hook = join(root, 'packages', 'click', 'dist', 'hooks', 'prompt.js');
const n = Number(process.argv[process.argv.indexOf('--n') + 1] ?? 20) || 20;

const tasks = readdirSync(join(mainRoot, 'bench', 'tasks', 'mined'))
  .filter((f) => f.endsWith('.json'))
  .flatMap((f) => {
    try {
      return [JSON.parse(readFileSync(join(mainRoot, 'bench', 'tasks', 'mined', f), 'utf8')) as { text: string; split: string }];
    } catch {
      return [];
    }
  })
  .filter((t) => t.split === 'test')
  .slice(0, n);

// warm the daemon first (a running daemon is the steady state the hook sees)
spawnSync(process.execPath, [join(root, 'packages', 'click', 'dist', 'click.js'), 'context', 'warm up', '--root', repo, '--budget', '1000'], { encoding: 'utf8', timeout: 120_000 });

const ms: number[] = [];
let delivered = 0;
for (const t of tasks) {
  const payload = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'latency', cwd: repo, prompt: t.text });
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [hook], { cwd: repo, input: payload, encoding: 'utf8', timeout: 10_000 });
  ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
  if (r.status === 0 && r.stdout.includes('additionalContext')) delivered++;
}

const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
const now = new Date();
const row = {
  runId: `${now.toISOString().replace(/[-:.]/g, '').slice(0, 18)}Z-hook`,
  ts: now.toISOString(),
  gitSha: sha,
  kind: 'latency',
  variant: 'hook',
  configHash: 'delivery',
  budget: 4000,
  split: 'test',
  n: ms.length,
  metrics: { p50ms: Math.round(percentile(ms, 0.5)), p95ms: Math.round(percentile(ms, 0.95)), maxMs: Math.round(Math.max(...ms)), delivered },
  note: 'wall clock of the bundled prompt hook per prompt (node start-up included), warm daemon, HydraDB local',
};
appendFileSync(join(root, 'bench', 'results.jsonl'), `${JSON.stringify(row)}\n`);
console.log(JSON.stringify(row.metrics), `n=${row.n}`);
