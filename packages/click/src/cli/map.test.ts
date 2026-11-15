import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectiveWeight } from '../../../core/src/graph/priors.js';
import { buildIndex } from '../../../core/src/indexer/build.js';
import { formatCandidates, formatStats, parseMapArgs, resolveNode, runMap } from './map.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'core', 'test', 'fixtures', 'mini-vue');
const NOW = () => new Date('2026-11-15T10:00:00.000Z');

let cacheDir: string;
beforeAll(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'click-map-'));
});
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));

async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runMap([...argv, '--root', FIXTURE], { out: (t) => (out += t), err: (t) => (err += t), cacheDir, now: NOW });
  return { code, out, err };
}

describe('click map --stats (PROMPTS 060)', () => {
  it('prints sizes, kinds, hubs, orphans, imports and links', async () => {
    const { code, out } = await run('--stats');
    expect(code).toBe(0);
    expect(out).toMatch(/^Graph [0-9a-f]{12} {2}·.* 23 files {2}·/);
    expect(out).toMatch(/Nodes by kind\n(  \S+ +\d+\n)+/);
    expect(out).toMatch(/component +9\n/);
    expect(out).toMatch(/store +2\n/);
    expect(out).toMatch(/uses_store +6\n/);
    expect(out).toContain('Top 15 hubs');
    expect(out).toMatch(/Unresolved local imports: 0 of \d+ \(0\.0%\) {2}\[gate: < 2%\]/);
    expect(out).toMatch(/Links: 35 cross-file refs → 35 resolved, 0 to a file node, 0 dropped/);
    expect(out).toMatch(/Orphans \(no edge except `contains`\): \d+/);
  });

  it('hubs are ranked by incoming edges, contains excluded', async () => {
    const r = await buildIndex(FIXTURE, undefined, { cacheDir, now: NOW });
    const hubs = formatStats(r).split('Top 15 hubs')[1]!.split('\n\n')[0]!.split('\n').slice(1).map((l) => l.trim());
    const counts = hubs.map((h) => Number(h.split(' ')[0]));
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(hubs.some((h) => h.includes('useOrderStore'))).toBe(true);
  });

  it('is the default mode', async () => {
    const strip = (t: string) => t.replace(/^Built in .*$/m, ''); // timings differ between runs
    expect(strip((await run()).out)).toBe(strip((await run('--stats')).out));
  });
});

describe('click map --node / --path (PROMPTS 061)', () => {
  it('shows neighbours in both directions with the weight the ranker would walk them with', async () => {
    const { code, out } = await run('--node', 'useOrderStore');
    expect(code).toBe(0);
    expect(out).toContain('sym:src/stores/order.ts#useOrderStore  [store]  src/stores/order.ts:7-29');
    expect(out).toMatch(/→ calls +w=0\.90 +sym:src\/utils\/money\.ts#sumMinor/);
    expect(out).toMatch(/← uses_store +w=0\.84 +sym:src\/components\/CheckoutButton\.vue#CheckoutButton/);
    expect(out).toMatch(/→ tested_by +w=0\.30 +sym:tests\/checkout\.spec\.ts/);
    // the numbers are exactly SPEC §6.2: prior × reverse factor for incoming edges
    expect(effectiveWeight('uses_store', 'in')).toBeCloseTo(0.84);
    expect(effectiveWeight('calls', 'out')).toBeCloseTo(0.9);
  });

  it('shows props and events on component edges', async () => {
    const out = (await run('--node', 'CheckoutButton')).out;
    expect(out).toMatch(/→ passes_prop +w=0\.60 .*BaseButton.*props: label,loading,disabled/);
    expect(out).toMatch(/→ uses_component .*BaseButton/);
  });

  it('resolves by exact id, by name, case-insensitively, and by substring; ambiguity lists candidates', async () => {
    const g = (await buildIndex(FIXTURE, undefined, { cacheDir, now: NOW })).graph;
    expect(resolveNode(g, 'sym:src/stores/cart.ts#useCartStore')).toMatchObject({ kind: 'one' });
    expect(resolveNode(g, 'usecartstore')).toMatchObject({ kind: 'one', node: { name: 'useCartStore' } });
    expect(resolveNode(g, 'route:/orders/:id')).toMatchObject({ kind: 'one' });
    expect(resolveNode(g, 'Order')).toMatchObject({ kind: 'one', node: { id: 'sym:src/types/order.ts#Order' } }); // an exact name beats substrings
    const many = resolveNode(g, 'cart');
    expect(many.kind).toBe('many');
    if (many.kind === 'many') {
      expect(many.nodes.length).toBeGreaterThan(2);
      expect(formatCandidates('cart', many.nodes)).toContain('pass one of these ids');
    }
    expect(resolveNode(g, 'definitely-not-here')).toEqual({ kind: 'none' });
  });

  it('an unknown node exits 1 with a hint', async () => {
    const r = await run('--node', 'nope-nope');
    expect(r.code).toBe(1);
    expect(r.err).toContain('no node matches "nope-nope"');
  });

  it('--path lists every node in the file with edge counts, and the file-level imports both ways', async () => {
    const { code, out } = await run('--path', 'src/stores/order.ts');
    expect(code).toBe(0);
    expect(out).toContain('src/stores/order.ts  ·  2 nodes');
    expect(out).toMatch(/store +useOrderStore {2}L7-29/);
    expect(out).toContain('Imports (2): src/types/order.ts, src/utils/money.ts');
    expect(out).toContain('Imported by (4): src/components/CheckoutButton.vue, src/views/CheckoutView.vue, src/views/OrderDetailView.vue, tests/checkout.spec.ts');
    expect((await run('--path', 'src\\stores\\order.ts')).out).toBe(out); // Windows separators
  });

  it('an unknown path exits 1', async () => {
    expect((await run('--path', 'src/missing.ts')).code).toBe(1);
  });
});

describe('argument parsing', () => {
  it('parses modes and options; reports mistakes', () => {
    expect(parseMapArgs(['--node', 'X', '--root', '/r', '--no-cache'], '/cwd')).toEqual({ mode: 'node', value: 'X', root: '/r', cache: false });
    expect(parseMapArgs([], '/cwd')).toEqual({ mode: 'stats', root: '/cwd', cache: true });
    expect(parseMapArgs(['--node'], '/cwd')).toBe('--node needs a value');
    expect(parseMapArgs(['--wat'], '/cwd')).toBe('unknown option --wat');
  });
  it('runMap reports usage errors with exit code 2', async () => {
    let err = '';
    expect(await runMap(['--wat'], { out: () => {}, err: (t) => (err += t) })).toBe(2);
    expect(err).toContain('usage: click map');
  });
});
