import { describe, expect, it } from 'vitest';

import type { PackedContext, PackedItem } from '../../packages/core/src/types.js';
import type { BenchTask } from './task.js';
import {
  pairedBootstrap,
  percentile,
  perType,
  precisionTokens,
  recallAny,
  recallStrict,
  symbolRecall,
} from './metrics.js';

function task(symbols: string[] = []): BenchTask {
  return {
    id: 'h-01', source: 'hand', text: 'Improve account loading.', type: 'multi-file',
    groundTruth: { files: ['src/a.ts', 'src/b.ts'], symbols }, split: 'test', e2e: false,
  };
}

function item(nodeId: string, path: string | null, mode: PackedItem['mode'], tokens: number, range?: PackedItem['range']): PackedItem {
  return { nodeId, path, name: nodeId, mode, tokens, range };
}

const context = (items: PackedItem[]): Pick<PackedContext, 'items'> => ({ items });

describe('retrieval metrics', () => {
  it('computes strict and any file recall by hand', () => {
    const packed = context([
      item('sym:src/a.ts#a', 'src/a.ts', 'signature', 10),
      item('sym:src/b.ts#b', 'src/b.ts', 'body', 20),
    ]);
    expect(recallStrict(task(), packed)).toBe(0.5);
    expect(recallAny(task(), packed)).toBe(1);
  });

  it('computes symbol recall from exact nodes, containing ranges, and whole files', () => {
    const symbols = new Map([
      ['sym:src/a.ts#one', { id: 'sym:src/a.ts#one', path: 'src/a.ts', range: { startLine: 10, endLine: 12 } }],
      ['sym:src/a.ts#two', { id: 'sym:src/a.ts#two', path: 'src/a.ts', range: { startLine: 20, endLine: 22 } }],
      ['sym:src/b.ts#three', { id: 'sym:src/b.ts#three', path: 'src/b.ts', range: { startLine: 5, endLine: 6 } }],
      ['sym:src/c.ts#miss', { id: 'sym:src/c.ts#miss', path: 'src/c.ts', range: { startLine: 1, endLine: 2 } }],
    ]);
    const ids = [...symbols.keys()];
    const packed = context([
      item(ids[0]!, 'src/a.ts', 'body', 10, { startLine: 10, endLine: 12 }),
      item('sym:src/a.ts#wrapper', 'src/a.ts', 'body', 20, { startLine: 18, endLine: 30 }),
      item('file:src/b.ts', 'src/b.ts', 'file', 30),
    ]);
    expect(symbolRecall(task(ids), packed, symbols)).toBe(0.75);
    expect(symbolRecall(task([]), packed, symbols)).toBeNull();
  });

  it('counts an exact packed symbol without requiring a graph location lookup', () => {
    const id = 'sym:src/a.ts#one';
    expect(symbolRecall(task([id]), context([item(id, 'src/a.ts', 'body', 10)]), new Map())).toBe(1);
  });

  it('computes token precision while excluding refs from the denominator', () => {
    const packed = context([
      item('a', 'src/a.ts', 'body', 40),
      item('b', 'src/b.ts', 'signature', 10),
      item('c', 'src/c.ts', 'file', 30),
      item('d', 'src/a.ts', 'ref', 20),
    ]);
    expect(precisionTokens(task(), packed)).toBe(0.5); // 40 relevant / 80 body+file+signature
  });

  it('macro-averages strict recall per task type', () => {
    expect(perType([
      { type: 'impact', recallStrict: 1 },
      { type: 'impact', recallStrict: 0 },
      { type: 'single-file', recallStrict: 0.75 },
    ])).toEqual({ impact: { n: 2, recallStrict: 0.5 }, 'single-file': { n: 1, recallStrict: 0.75 } });
  });
});

describe('statistics', () => {
  it('linearly interpolates percentiles on a hand-computed sample', () => {
    expect(percentile([0, 10, 20, 30], 0.5)).toBe(15);
    expect(percentile([0, 10, 20, 30], 0.25)).toBe(7.5);
  });

  it('returns the exact paired result when every pair differs by one', () => {
    expect(pairedBootstrap([0, 2, 4], [1, 3, 5], 100, 42)).toEqual({ diff: 1, lo: 1, hi: 1 });
  });

  it('is deterministic for the same seed', () => {
    const first = pairedBootstrap([0, 0, 1], [0, 1, 1], 200, 7);
    expect(pairedBootstrap([0, 0, 1], [0, 1, 1], 200, 7)).toEqual(first);
  });
});
