import { describe, expect, it } from 'vitest';

import type { GraphNode } from '../../packages/core/src/types.js';
import { overlappingSymbols, parseDiffRanges, translateSymbolsAtH } from './gt-symbols.js';

const node = (id: string, path: string, name: string, startLine: number, endLine: number): GraphNode => ({
  id, path, name, kind: 'function', range: { startLine, endLine }, tokens: 1, sigTokens: 1, fileHash: 'h',
});

describe('ground-truth symbol mapping', () => {
  it('parses added lines on post and deleted lines on pre, including zero-count hunks', () => {
    const ranges = parseDiffRanges(`--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2,3 +2,0 @@\n@@ -10,0 +8,2 @@`);
    expect(ranges.pre.get('src/a.ts')).toEqual([{ startLine: 2, endLine: 4 }]);
    expect(ranges.post.get('src/a.ts')).toEqual([{ startLine: 8, endLine: 9 }]);
  });

  it('selects every overlapping symbol range', () => {
    const file = { ...node('file:src/a.ts', 'src/a.ts', 'src/a.ts', 1, 20), kind: 'file' as const };
    const nodes = [file, node('a', 'src/a.ts', 'a', 1, 5), node('b', 'src/a.ts', 'b', 8, 12)];
    expect(overlappingSymbols(nodes, new Map([['src/a.ts', [{ startLine: 4, endLine: 9 }]]])).map(({ id }) => id)).toEqual(['a', 'b']);
  });

  it('translates renamed historical symbols to node ids at H and drops deleted symbols', () => {
    const historical = [node('sym:old.ts#useX', 'old.ts', 'useX', 1, 2), node('sym:old.ts#gone', 'old.ts', 'gone', 4, 5)];
    const atH = [node('sym:new.ts#useX', 'new.ts', 'useX', 1, 2), node('sym:other.ts#gone', 'other.ts', 'gone', 4, 5)];
    expect(translateSymbolsAtH(historical, atH, ['new.ts']).map(({ id }) => id)).toEqual(['sym:new.ts#useX']);
  });

  it('does not retain an exact id outside the candidate ground-truth files', () => {
    const historical = [node('sym:a.ts#useX', 'a.ts', 'useX', 1, 2)];
    const atH = [node('sym:a.ts#useX', 'a.ts', 'useX', 1, 2)];
    expect(translateSymbolsAtH(historical, atH, ['b.ts'])).toEqual([]);
  });
});
