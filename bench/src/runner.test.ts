import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { PackedContext } from '../../packages/core/src/types.js';
import { parseRunnerArgs, runBenchmark, selectTasks, writeRunArtifacts, type RunnerOptions } from './runner.js';
import type { BenchTask } from './task.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function task(index: number, split: 'train' | 'test' = 'test'): BenchTask {
  return {
    id: `h-${String(index).padStart(2, '0')}`, source: 'hand', text: `Task ${index}`,
    type: index % 2 ? 'single-file' : 'impact', groundTruth: { files: [`src/${index}.ts`], symbols: [] },
    split, e2e: index === 3,
  };
}

const options: RunnerOptions = { variant: 'oracle', budget: 4_000, split: 'test', retriever: 'oracle' };

describe('runner options', () => {
  it('parses the documented CLI and filters tasks', () => {
    const parsed = parseRunnerArgs(['--variant', 'V3', '--budget', '8000', '--split', 'test', '--types', 'impact', '--limit', '1', '--retriever', 'http', '--seed-reserve', '0']);
    expect(parsed).toEqual({ variant: 'V3', budget: 8_000, split: 'test', types: ['impact'], limit: 1, retriever: 'http', seedReserve: 0 });
    expect(selectTasks([task(1), task(2), task(3, 'train')], parsed).map((value) => value.id)).toEqual(['h-02']);
  });

  it('validates the semantic reserve range', () => {
    expect(() => parseRunnerArgs(['--variant', 'V3', '--budget', '4000', '--split', 'train', '--seed-reserve', '9'])).toThrow('between 0 and 8');
  });
});

describe('runBenchmark', () => {
  it('counts a V1 chunk whose range covers a ground-truth symbol at H', async () => {
    const value = task(1);
    const id = 'sym:src/1.ts#target';
    value.groundTruth.symbols = [id];
    const run = await runBenchmark([value], async (_task, budget) => ({
      contextId: 'ctx', text: '', tokens: 10, budget,
      items: [{ nodeId: 'chunk:src/1.ts#target#0', path: 'src/1.ts', name: 'target', mode: 'body', tokens: 10, range: { startLine: 8, endLine: 20 } }],
      seeds: [], variant: 'V1', configHash: 'cfg', pruner: 'none', graphVersion: 'g', weightsVersion: null,
      timings: { total: 1 }, degraded: [],
    }), options, {
      gitSha: 'abc',
      symbolLocations: new Map([[id, { id, path: 'src/1.ts', range: { startLine: 10, endLine: 12 } }]]),
    });
    expect(run.details[0]?.symbolRecall).toBe(1);
    expect(run.row.metrics.symbolRecall).toBe(1);
  });

  it('caps concurrency at four and aggregates metrics, pruners, degradation, and latency', async () => {
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 6 }, (_, index) => task(index + 1));
    const run = await runBenchmark(tasks, async (value, budget) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      active--;
      const hit = Number(value.id.slice(2)) % 2 === 0;
      return {
        contextId: value.id, text: '', tokens: 0, budget,
        items: hit ? [{ nodeId: `file:${value.groundTruth.files[0]}`, path: value.groundTruth.files[0]!, name: 'file', mode: 'file', tokens: 10 }] : [],
        seeds: [], variant: 'oracle', configHash: 'cfg', pruner: hit ? 'none' : 'fallback:jev->none',
        graphVersion: 'g', weightsVersion: null, timings: { total: Number(value.id.slice(2)) },
        degraded: hit ? [] : ['semantic-timeout'],
      } satisfies PackedContext;
    }, options, { gitSha: 'abc', now: new Date('2026-01-01T00:00:00Z') });

    expect(peak).toBe(4);
    expect(run.row).toMatchObject({ n: 6, configHash: 'cfg', metrics: { recallStrict: 0.5, recallAny: 0.5 }, pruner: { none: 3, 'fallback:jev->none': 3 }, degraded: { 'semantic-timeout': 3 } });
    expect(run.details[0]?.missingGroundTruthFiles).toHaveLength(1);
    expect(run.details[1]?.missingGroundTruthFiles).toHaveLength(0);
  });

  it('writes per-task details, appends rows, and regenerates Markdown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'click-runner-'));
    dirs.push(dir);
    const makeRun = async () => runBenchmark([task(2)], async (value, budget) => ({
      contextId: value.id, text: '', tokens: 0, budget, items: [], seeds: [], variant: 'empty', configHash: 'cfg',
      pruner: 'none', graphVersion: 'g', weightsVersion: null, timings: { total: 2 }, degraded: [],
    }), { ...options, variant: 'empty', retriever: 'empty' }, { gitSha: 'abc' });
    const first = await makeRun();
    const second = await makeRun();
    await writeRunArtifacts(dir, first);
    await writeRunArtifacts(dir, second);
    expect((await readFile(join(dir, 'results.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2);
    expect(await readFile(join(dir, 'results.md'), 'utf8')).toContain('| Run | Variant | Budget |');
    expect(await readFile(join(dir, 'runs', `${first.row.runId}.jsonl`), 'utf8')).toContain('"taskId":"h-02"');
  });
});
