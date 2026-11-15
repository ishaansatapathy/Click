import { describe, expect, it } from 'vitest';

import {
  configHash,
  PRESETS,
  resolveConfig,
  variantConfigSchema,
  type PresetName,
} from './config.js';

describe('variant config presets', () => {
  it.each(Object.keys(PRESETS) as PresetName[])('%s satisfies the schema', (name) => {
    expect(variantConfigSchema.parse(PRESETS[name])).toEqual(PRESETS[name]);
  });

  it('encodes the intended V1 through V4 differences', () => {
    expect(PRESETS.V1.semantic).toEqual({ mode: 'local', k: 30, timeoutMs: 400 });
    expect(PRESETS.V1).toMatchObject({ units: 'chunk', expand: { kind: 'none' } });
    expect(PRESETS.V1.seeds.sources).toEqual(['semantic']);
    expect(PRESETS.V2).toMatchObject({ units: 'symbol', expand: { kind: 'none' } });
    expect(PRESETS.V3).toMatchObject({ expand: { kind: 'ppr', usePriors: true } });
    expect(PRESETS.V4.prune.chain).toEqual(['jev', 'rerank', 'none']);
    expect(PRESETS.delivery.pack).toMatchObject({ prefix: true, sessionDedupe: true });
  });

  it('graph source: HydraDB by default (2 hops, frontier 200, 250 ms deadline); V3r is V3 on the local replica', () => {
    for (const name of ['V1', 'V2', 'V3', 'V4', 'delivery'] as const) {
      expect(PRESETS[name].expand, name).toMatchObject({ graphSource: 'hydra', hops: 2, maxFrontier: 200, graphTimeoutMs: 250 });
    }
    expect(PRESETS.V3r.expand).toMatchObject({ kind: 'ppr', usePriors: true, graphSource: 'replica' });
    // V3r differs from V3 in the graph source and nothing else
    expect({ ...PRESETS.V3r, id: 'V3', expand: { ...PRESETS.V3r.expand, graphSource: 'hydra' } }).toEqual(PRESETS.V3);
  });

  it('rejects invalid graph settings', () => {
    expect(() => resolveConfig(undefined, 'V3', { expand: { hops: 3 as never } })).toThrow();
    expect(() => resolveConfig(undefined, 'V3', { expand: { graphSource: 'cloud' as never } })).toThrow();
    expect(() => resolveConfig(undefined, 'V3', { expand: { graphTimeoutMs: 0 } })).toThrow();
    expect(resolveConfig({ expand: { hops: 1, graphTimeoutMs: 300 } }, 'V3').expand).toMatchObject({ hops: 1, graphTimeoutMs: 300, graphSource: 'hydra' });
  });
});

describe('resolveConfig', () => {
  it('deep-merges repo config and call-site overrides without mutating the preset', () => {
    const before = structuredClone(PRESETS.V3);
    const config = resolveConfig(
      { seeds: { count: 16 }, pack: { maxBodyTokens: 900 } },
      'V3',
      { budgetTokens: 8_000, seeds: { weights: { symbol: 2 } } },
    );

    expect(config).toMatchObject({
      id: 'V3',
      budgetTokens: 8_000,
      seeds: { count: 16, weights: { symbol: 2, bm25: 1, semantic: 1 } },
      pack: { maxBodyTokens: 900, neighbourSignatures: true },
    });
    expect(PRESETS.V3).toEqual(before);
  });

  it('rejects invalid merged values', () => {
    expect(() => resolveConfig({ deadlineMs: 0 }, 'V3')).toThrow();
  });
});

describe('configHash', () => {
  it('is stable for equivalent configs', () => {
    const first = resolveConfig({ budgetTokens: 8_000 }, 'V3');
    const second = resolveConfig(undefined, 'V3', { budgetTokens: 8_000 });
    expect(configHash(first)).toBe(configHash(second));
    expect(configHash(first)).toMatch(/^[a-f0-9]{12}$/);
  });

  it('changes when the config changes', () => {
    expect(configHash(PRESETS.V2)).not.toBe(configHash(PRESETS.V3));
    expect(configHash(PRESETS.V3)).not.toBe(configHash(PRESETS.V3r));
    expect(new Set(Object.values(PRESETS).map(configHash)).size).toBe(Object.keys(PRESETS).length);
  });
});
