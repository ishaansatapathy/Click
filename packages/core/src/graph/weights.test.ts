import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildIndex } from '../indexer/build.js';
import type { EdgeKind, WeightsDoc } from '../types.js';
import { EDGE_KINDS, buildCsr, type Csr, type CsrEdge } from './csr.js';
import { PRIORS } from './priors.js';
import { applyWeights, learnedEdges, settingsKey, weightSettings, type WeightSettings } from './weights.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');
const DEFAULTS: WeightSettings = { usePriors: true, reverseScale: 1, useLearned: false };

const edge = (from: string, kind: EdgeKind, to: string): CsrEdge => ({ key: `${from}|${kind}|${to}`, from, to, kind });
const doc = (multipliers: Record<string, number> = {}, addedEdges: WeightsDoc['addedEdges'] = [], version = 'w1'): WeightsDoc => ({
  v: 1, version, derivedFrom: null, events: 1, params: { alpha: 0.2, beta: 0.1, min: 0.1, max: 5 }, multipliers, addedEdges,
});
/** weight of the arc from `u` to `v` of kind `kind`. */
function arcWeight(csr: Csr, u: string, kind: EdgeKind, v: string): number {
  const ui = csr.index.get(u)!;
  for (let a = csr.offsets[ui]!; a < csr.offsets[ui + 1]!; a++) if (csr.ids[csr.targets[a]!] === v && EDGE_KINDS[csr.kind[a]!] === kind) return csr.w[a]!;
  throw new Error(`no arc ${u} -${kind}-> ${v}`);
}

const base = buildCsr(['a', 'b', 'c'], [edge('a', 'uses_store', 'b'), edge('a', 'imports', 'c'), edge('b', 'calls', 'c')]);

describe('applyWeights (PROMPTS 082 / SPEC §6.2)', () => {
  it('forward arcs get the prior, reverse arcs prior × reverse factor', () => {
    const c = applyWeights(base, DEFAULTS);
    expect(arcWeight(c, 'a', 'uses_store', 'b')).toBeCloseTo(PRIORS.uses_store.prior); // 1.2
    expect(arcWeight(c, 'b', 'uses_store', 'a')).toBeCloseTo(PRIORS.uses_store.prior * PRIORS.uses_store.reverse); // 0.84
    expect(arcWeight(c, 'a', 'imports', 'c')).toBeCloseTo(0.6);
    expect(arcWeight(c, 'c', 'imports', 'a')).toBeCloseTo(0.3);
    expect(arcWeight(c, 'b', 'calls', 'c')).toBeCloseTo(0.9);
  });

  it('wsum is the sum of each node\'s arc weights', () => {
    const c = applyWeights(base, DEFAULTS);
    for (let u = 0; u < c.n; u++) {
      let s = 0;
      for (let a = c.offsets[u]!; a < c.offsets[u + 1]!; a++) s += c.w[a]!;
      expect(c.wsum[u]).toBeCloseTo(s, 5);
    }
    expect(c.wsum[c.index.get('a')!]).toBeCloseTo(1.2 + 0.6);
  });

  it('usePriors=false: every forward arc is 1 and every reverse arc 0.5', () => {
    const c = applyWeights(base, { ...DEFAULTS, usePriors: false });
    expect(arcWeight(c, 'a', 'uses_store', 'b')).toBe(1);
    expect(arcWeight(c, 'b', 'calls', 'c')).toBe(1);
    expect(arcWeight(c, 'c', 'imports', 'a')).toBe(0.5);
  });

  it('reverseScale multiplies reverse arcs only, and 0 turns them off', () => {
    const c2 = applyWeights(base, { ...DEFAULTS, reverseScale: 2 });
    expect(arcWeight(c2, 'b', 'uses_store', 'a')).toBeCloseTo(1.68);
    expect(arcWeight(c2, 'a', 'uses_store', 'b')).toBeCloseTo(1.2);
    const c0 = applyWeights(base, { ...DEFAULTS, reverseScale: 0 });
    expect(arcWeight(c0, 'b', 'uses_store', 'a')).toBe(0);
    expect(c0.wsum[c0.index.get('c')!]).toBe(0); // c has only reverse arcs
  });

  it('learned multipliers apply only when useLearned is on; unknown keys are ignored; no doc is fine', () => {
    const d = doc({ 'a|uses_store|b': 1.44, 'ghost|calls|nothing': 9, '__proto__': 7 });
    const off = applyWeights(base, DEFAULTS, d);
    expect(arcWeight(off, 'a', 'uses_store', 'b')).toBeCloseTo(1.2);
    const on = applyWeights(base, { ...DEFAULTS, useLearned: true }, d);
    expect(arcWeight(on, 'a', 'uses_store', 'b')).toBeCloseTo(1.2 * 1.44);
    expect(arcWeight(on, 'b', 'uses_store', 'a')).toBeCloseTo(0.84 * 1.44); // the same multiplier applies to the reverse arc
    expect(arcWeight(on, 'b', 'calls', 'c')).toBeCloseTo(0.9);
    expect(() => applyWeights(base, { ...DEFAULTS, useLearned: true }, null)).not.toThrow();
  });

  it('learned co_changed edges exist in the structure but carry no mass unless useLearned', () => {
    const d = doc({ 'a|co_changed|c': 2 }, [{ key: 'a|co_changed|c', from: 'a', to: 'c', kind: 'co_changed', meta: { source: 'learned' } }]);
    const withEdge = buildCsr(['a', 'b', 'c'], [...base.edges, ...learnedEdges(d)]);
    expect(withEdge.targets.length).toBe(base.targets.length + 2);
    const off = applyWeights(withEdge, DEFAULTS, d);
    expect(arcWeight(off, 'a', 'co_changed', 'c')).toBe(0);
    expect(off.wsum[off.index.get('a')!]).toBeCloseTo(1.2 + 0.6); // identical to the graph without the learned edge
    const on = applyWeights(withEdge, { ...DEFAULTS, useLearned: true }, d);
    expect(arcWeight(on, 'a', 'co_changed', 'c')).toBeCloseTo(0.8 * 2);
    expect(arcWeight(on, 'c', 'co_changed', 'a')).toBeCloseTo(0.8 * 2); // symmetric: reverse factor 1
  });

  it('never mutates its input: the structure is shared, the weights are fresh arrays', () => {
    const before = Array.from(base.w);
    const c = applyWeights(base, DEFAULTS);
    expect(c.offsets).toBe(base.offsets);
    expect(c.targets).toBe(base.targets);
    expect(c.edgeIdx).toBe(base.edgeIdx);
    expect(c.dir).toBe(base.dir);
    expect(c.kind).toBe(base.kind);
    expect(c.w).not.toBe(base.w);
    expect(Array.from(base.w)).toEqual(before);
    expect(Array.from(base.w).every((x) => x === 0)).toBe(true);
    // re-weighting does not disturb an earlier weighted copy
    const first = Array.from(c.w);
    applyWeights(base, { ...DEFAULTS, usePriors: false });
    expect(Array.from(c.w)).toEqual(first);
  });

  it('on a real graph every arc has a positive weight with the default settings', async () => {
    const { graph } = await buildIndex(FIXTURE, undefined, { cache: false });
    const { csrFromGraph } = await import('./csr.js');
    const c = applyWeights(csrFromGraph(graph), DEFAULTS);
    expect(Array.from(c.w).every((x) => x > 0)).toBe(true);
    expect(c.wsum.every((x, i) => (c.offsets[i + 1]! - c.offsets[i]! === 0 ? x === 0 : x > 0))).toBe(true);
  });

  it('helpers: settings key and weight settings', () => {
    expect(settingsKey(DEFAULTS)).toBe('1|1|0');
    expect(settingsKey({ ...DEFAULTS, reverseScale: 2, useLearned: true })).toBe('1|2|1');
    expect(weightSettings({ ...DEFAULTS, kind: 'ppr' } as never)).toEqual(DEFAULTS);
  });
});
