import { describe, expect, it } from 'vitest';

import type { ResultRow, TaskDetail } from '../src/runner.js';
import { assertFallbackMatches, latencyRow, renderDrill } from './hydra-fallback-drill.js';

const detail = (taskId: string, recallStrict = 1, missing: string[] = []): TaskDetail => ({
  taskId, type: 'multi-hop', recallStrict, recallAny: recallStrict, symbolRecall: recallStrict, precisionTokens: 0.5, latencyMs: taskId === 'a' ? 10 : 20,
  groundTruthFiles: ['src/a.ts'], missingGroundTruthFiles: missing, items: [],
});
const base: ResultRow = {
  runId: 'r', ts: '2026-01-01T00:00:00Z', gitSha: 'g', kind: 'retrieval', variant: 'V3', configHash: 'c', budget: 4_000, split: 'test', n: 2,
  metrics: { recallStrict: 1, recallAny: 1, symbolRecall: 1, precisionTokens: 0.5, p50ms: 15, p95ms: 20 },
  perType: { 'multi-hop': { n: 2, recallStrict: 1 } }, pruner: { none: 2 }, degraded: {},
};

describe('HydraDB fallback drill (PROMPT 144)', () => {
  it('requires every offline task to match its V3r reference', () => {
    expect(() => assertFallbackMatches([detail('a')], [detail('a')])).not.toThrow();
    expect(() => assertFallbackMatches([detail('a', 0, ['src/a.ts'])], [detail('a')])).toThrow('does not match');
    expect(() => assertFallbackMatches([detail('b')], [detail('a')])).toThrow('missing from V3r');
  });

  it('builds a clearly labelled latency row over only the post-stop requests', () => {
    const row = latencyRow([detail('a'), detail('b')], base, 'sha', new Date('2026-01-02T00:00:00Z'), 'v3r');
    expect(row).toMatchObject({ kind: 'latency', variant: 'V3-hydra-offline', n: 2, degraded: { 'graph-replica': 2 }, metrics: { recallStrict: 1, p50ms: 15, p95ms: 19.5 } });
    expect(renderDrill(row, 3, [], 'v3r')).toContain('All 3 requests returned');
  });
});
