import { describe, expect, it } from 'vitest';

import type { ContextRecord } from '../../packages/core/src/contracts.js';
import type { GraphNode } from '../../packages/core/src/types.js';
import type { BenchTask } from '../src/task.js';
import { groundTruthSymbolNames, jsonLines, pairedBootstrap, simulatedOutcome, simulatedRecord, temporalTrain, UNDATED_TRAIN_TS } from './sim-outcomes.js';

const task = (id: string, date: string | undefined, split: 'train' | 'test' = 'train'): BenchTask => ({
  id, source: 'mined', commit: `${id.slice(2).padEnd(40, '0')}`, parentCommit: 'b'.repeat(40), ...(date ? { date } : {}),
  text: `task ${id}`, type: 'single-file', groundTruth: { files: ['src/a.ts'], symbols: ['sym:src/a.ts#a'] },
  split, e2e: false,
});

const record: ContextRecord = {
  v: 1, contextId: 'random', ts: '2026-11-16T00:00:00.000Z', source: 'bench', variant: 'V3', configHash: 'c',
  graphVersion: 'g', weightsVersion: null, taskText: 'x', taskHash: 'h', repoCommit: 'abc',
  seeds: [{ nodeId: 'sym:src/a.ts#a', score: 1 }], items: [{ nodeId: 'sym:src/a.ts#a', mode: 'body' }],
  attribution: {}, tokens: 10, ms: 2, degraded: [],
};

const nodes = new Map<string, GraphNode>([['sym:src/a.ts#a', {
  id: 'sym:src/a.ts#a', kind: 'function', name: 'a', path: 'src/a.ts', range: { startLine: 1, endLine: 2 },
  signature: 'function a()', tokens: 4, sigTokens: 3, fileHash: 'h',
}]]);

describe('simulated outcomes (PROMPT 159)', () => {
  it('uses only train tasks in temporal order with id as the deterministic tie break', () => {
    expect(temporalTrain([task('m-0000004', undefined), task('m-0000002', '2024-01-02T00:00:00Z'), task('m-0000003', '2024-01-01T00:00:00Z', 'test'), task('m-0000001', '2024-01-02T00:00:00Z')]).map((t) => t.id))
      .toEqual(['m-0000001', 'm-0000002', 'm-0000004']);
  });

  it('puts undated hand-style train events last with an explicit deterministic timestamp', () => {
    const t = task('m-0000001', undefined);
    const r = simulatedRecord(record, t);
    expect(r.ts).toBe(UNDATED_TRAIN_TS);
    expect(simulatedOutcome(t, r, nodes).ts).toBe(UNDATED_TRAIN_TS);
  });

  it('labels both records and outcomes as simulated and copies only ground truth into edits/diff symbols', () => {
    const t = task('m-0000001', '2024-01-02T00:00:00Z');
    const r = simulatedRecord(record, t);
    const out = simulatedOutcome(t, r, nodes);
    expect(r).toMatchObject({ contextId: 'ctx_bench_sim_m_0000001', source: 'bench-sim', ts: t.date });
    expect(out).toMatchObject({ source: 'bench-sim', contextIds: [r.contextId], filesEdited: ['src/a.ts'], diffSymbols: ['a'], check: { kind: 'none', passed: true } });
    expect(out.filesRead).toEqual(['src/a.ts']);
  });

  it('deduplicates symbol names, rejects missing indexed symbols, and writes valid JSONL', () => {
    const t = task('m-0000001', '2024-01-02T00:00:00Z');
    expect(groundTruthSymbolNames({ ...t, groundTruth: { ...t.groundTruth, symbols: ['sym:src/a.ts#a', 'sym:src/a.ts#a'] } }, nodes)).toEqual(['a']);
    expect(() => groundTruthSymbolNames({ ...t, groundTruth: { ...t.groundTruth, symbols: ['sym:src/a.ts#missing'] } }, nodes)).toThrow('not indexed');
    expect(jsonLines([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}\n');
  });

  it('computes a deterministic paired bootstrap and rejects unpaired tasks', () => {
    const detail = (taskId: string, recallStrict: number) => ({ taskId, recallStrict }) as never;
    expect(pairedBootstrap([detail('a', 0), detail('b', 1)], [detail('a', 1), detail('b', 1)], 100)).toEqual({ delta: 0.5, lo: 0, hi: 1 });
    expect(() => pairedBootstrap([detail('a', 0)], [detail('b', 1)], 10)).toThrow('unpaired');
  });
});
