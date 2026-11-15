import { describe, expect, it } from 'vitest';
import { dependents, forceLayout, testsFor } from './layout.js';

const edges = [
  { from: 'page', to: 'store', kind: 'uses_store' },
  { from: 'router', to: 'page', kind: 'routes_to' },
  { from: 'store', to: 'util', kind: 'imports' },
  { from: 'util', to: 'store', kind: 'imports' }, // a cycle
  { from: 'util', to: 'util.test', kind: 'tested_by' },
  { from: 'a', to: 'b', kind: 'co_changed' },
];

describe('dependents ("what breaks if I change X")', () => {
  it('walks incoming dependency edges, nearest first, with the edge chain', () => {
    const d = dependents({ edges }, 'util', 3);
    expect(d.map((x) => [x.id, x.hops])).toEqual([['store', 1], ['page', 2], ['router', 3]]);
    expect(d.find((x) => x.id === 'router')!.chain).toEqual(['imports', 'uses_store', 'routes_to']);
  });
  it('respects the hop limit and survives cycles', () => {
    expect(dependents({ edges }, 'util', 1).map((x) => x.id)).toEqual(['store']);
    expect(dependents({ edges }, 'store', 5).some((x) => x.id === 'store')).toBe(false);
  });
  it('ignores co-change and test edges as dependencies, and finds tests separately', () => {
    expect(dependents({ edges }, 'b')).toEqual([]);
    expect(dependents({ edges }, 'util.test')).toEqual([]);
    expect(testsFor({ edges }, 'util')).toEqual(['util.test']);
  });
});

describe('forceLayout', () => {
  const ids = ['page', 'store', 'router', 'util', 'a', 'b'];
  it('is deterministic and keeps every node inside the canvas', () => {
    const one = forceLayout(ids, edges, { width: 400, height: 300 });
    const two = forceLayout(ids, edges, { width: 400, height: 300 });
    expect([...one]).toEqual([...two]);
    for (const p of one.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(400);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(300);
    }
  });
  it('puts linked nodes closer together than unlinked ones, on average', () => {
    const pos = forceLayout(ids, edges, { width: 600, height: 400 });
    const dist = (a: string, b: string): number => Math.hypot(pos.get(a)!.x - pos.get(b)!.x, pos.get(a)!.y - pos.get(b)!.y);
    expect((dist('page', 'store') + dist('store', 'util')) / 2).toBeLessThan((dist('router', 'a') + dist('router', 'b')) / 2);
  });
});
