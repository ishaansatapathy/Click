import { describe, expect, it } from 'vitest';

import type { Convention, Graph, GraphEdge, GraphNode } from '../../packages/core/src/types.js';
import type { CandidateSymbols } from './gt-symbols.js';
import { classifyCandidate, isImpact, isMultiHop, matchingConvention } from './classify.js';

const node = (id: string): GraphNode => ({ id, kind: id.startsWith('file:') ? 'file' : 'function', path: null, name: id, tokens: 1, sigTokens: 1, fileHash: 'h' });
const edge = (from: string, kind: GraphEdge['kind'], to: string): GraphEdge => ({ from, kind, to, key: `${from}|${kind}|${to}` });
const graph = (ids: string[], edges: GraphEdge[]): Graph => ({ version: 'v', repoCommit: null, nodes: ids.map(node), edges, chunks: [] });
const candidate = (files: string[], changed: string[] = []): CandidateSymbols => ({
  sha: 'a'.repeat(40), date: '2026-01-01T00:00:00Z', authorName: 'a', authorEmail: 'a@example.com', message: 'change', files: [],
  groundTruthFiles: files, changedLines: 1, groundTruthSymbols: [], signatureChangedSymbols: changed,
});

describe('benchmark task classification', () => {
  it('counts distinct incoming non-containment dependents for impact tasks', () => {
    const g = graph(['s', 'a', 'b', 'c'], [edge('a', 'calls', 's'), edge('b', 'imports', 's'), edge('c', 'uses_store', 's'), edge('f', 'contains', 's')]);
    expect(isImpact(candidate(['a.ts', 'b.ts'], ['s']), g)).toBe(true);
  });

  it('detects a non-direct path joining ground-truth files', () => {
    const g = graph(['file:a.ts', 'x', 'file:b.ts'], [edge('file:a.ts', 'contains', 'x'), edge('file:b.ts', 'imports', 'x')]);
    expect(isMultiHop(['a.ts', 'b.ts'], g)).toBe(true);
    expect(isMultiHop(['a.ts', 'missing.ts'], g)).toBe(false);
  });

  it('matches a convention only with substantive lexical overlap', () => {
    const conventions: Convention[] = [{ id: 'conv:auto', text: 'APIs such as ref and computed are auto-imported; do not import them manually.', source: 'detected', validFrom: 'now', validTo: null }];
    expect(matchingConvention('Stop manually importing computed and ref APIs.', conventions)).toBe('conv:auto');
    expect(matchingConvention('Update the component layout.', conventions)).toBeNull();
  });

  it('uses the specified classification priority', () => {
    const g = graph(['file:a.ts', 'file:b.ts', 's', 'a', 'b', 'c'], [edge('a', 'calls', 's'), edge('b', 'calls', 's'), edge('c', 'calls', 's')]);
    expect(classifyCandidate(candidate(['a.ts'], ['s']), g, [])).toBe('single-file');
    expect(classifyCandidate(candidate(['a.ts', 'b.ts'], ['s']), g, [])).toBe('impact');
  });
});
