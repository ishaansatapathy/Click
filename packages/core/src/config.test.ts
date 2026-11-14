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
    expect(PRESETS.V1).toMatchObject({ units: 'chunk', expand: { kind: 'none' } });
    expect(PRESETS.V1.seeds.sources).toEqual(['semantic']);
    expect(PRESETS.V2).toMatchObject({ units: 'symbol', expand: { kind: 'none' } });
    expect(PRESETS.V3).toMatchObject({ expand: { kind: 'ppr', usePriors: true } });
    expect(PRESETS.V4.prune.chain).toEqual(['jev', 'rerank', 'none']);
    expect(PRESETS.delivery.pack).toMatchObject({ prefix: true, sessionDedupe: true });
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
  });
});
