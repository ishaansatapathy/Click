// SPEC §18.1: the prompt hook's process cold start is under 100 ms. Timing only means something when nothing else is running, so this
// lives in the slow suite (`pnpm test:slow`, which runs files one at a time) instead of the parallel fast suite.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bundle } from '../build/bundle.js';

let out: string;
const bare = mkdtempSync(join(tmpdir(), 'click-cold-'));
beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'click-cold-dist-'));
  await bundle({ outdir: out, hooksOnly: true });
}, 60_000);
afterAll(() => {
  rmSync(out, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
});

const run = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [join(out, 'hooks', 'prompt.js')], { cwd: bare, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', () => resolve(performance.now() - t0));
    child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: bare, prompt: 'add a loading state to the checkout button' }));
  });

it('node dist/hooks/prompt.js < payload.json starts, decides and exits in < 100 ms (median of 15)', async () => {
  await run(); // warm the disk cache
  const times: number[] = [];
  for (let i = 0; i < 15; i++) times.push(await run());
  times.sort((a, b) => a - b);
  const median = times[7]!;
  process.stdout.write(`hook cold start: median ${median.toFixed(0)} ms, min ${times[0]!.toFixed(0)}, max ${times.at(-1)!.toFixed(0)}
`);
  expect(median).toBeLessThan(100);
}, 60_000);
