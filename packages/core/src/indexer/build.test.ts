import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGraph, buildIndex, graphVersion } from './build.js';
import { profileRepo } from './profile.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');
const NOW = () => new Date('2026-11-15T10:00:00.000Z');

const temps: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'click-build-'));
  temps.push(d);
  return d;
};
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});
const copyFixture = (): string => {
  const d = tmp();
  cpSync(FIXTURE, d, { recursive: true });
  return d;
};

describe('buildIndex on the fixture (PROMPTS 057)', () => {
  it('builds the whole graph: components, stores, composables, routes, tests, types and their edges', async () => {
    const r = await buildIndex(FIXTURE, undefined, { cacheDir: tmp(), now: NOW });
    expect(r.stats.nodesByKind).toEqual({ component: 9, composable: 3, file: 22, function: 5, route: 4, store: 2, test: 1, type: 3 });
    // exact counts are regression guards for the fixture; update them deliberately when the fixture or the rules change
    expect(r.stats.edgesByKind).toEqual({ calls: 8, contains: 27, emits_to: 3, has_type: 3, imports: 30, passes_prop: 4, routes_to: 4, tested_by: 2, uses_component: 5, uses_composable: 4, uses_store: 6 });
    expect(r.stats.link).toMatchObject({ refs: 35, resolved: 35, fileFallback: 0, dropped: 0, routes: 4 });
    expect(r.stats.imports.unresolved).toBe(0);
    expect(r.stats.unresolvedLocalRatio).toBe(0);
    expect(r.stats.byClass).toEqual({ config: 1, generated: 2, src: 19, test: 1 });
  });

  it('graph invariants: edges connect nodes, chunks carry no text in the graph but do in the result, version is a stable hash', async () => {
    const r = await buildIndex(FIXTURE, undefined, { cacheDir: tmp(), now: NOW });
    const ids = new Set(r.graph.nodes.map((n) => n.id));
    for (const e of r.graph.edges) expect(ids.has(e.from) && ids.has(e.to), e.key).toBe(true);
    expect(r.graph.chunks.every((c) => !('text' in c))).toBe(true);
    expect(r.chunks.every((c) => c.text.length > 0)).toBe(true);
    expect(r.graph.chunks.map((c) => c.id)).toEqual(r.chunks.map((c) => c.id));
    expect(r.graph.version).toMatch(/^[0-9a-f]{12}$/);
    expect(r.graph.repoCommit === null || /^[0-9a-f]{40}$/.test(r.graph.repoCommit)).toBe(true);
    expect(r.conventions.length).toBeGreaterThan(0);
  });

  it('is deterministic: identical output on a cold run, a cached run and a no-cache run', async () => {
    const cacheDir = tmp();
    const cold = await buildIndex(FIXTURE, undefined, { cacheDir, now: NOW });
    const warm = await buildIndex(FIXTURE, undefined, { cacheDir, now: NOW });
    const none = await buildIndex(FIXTURE, undefined, { cache: false, now: NOW });
    const strip = (x: typeof cold) => JSON.stringify({ g: x.graph, c: x.chunks, v: x.conventions });
    expect(strip(warm)).toBe(strip(cold));
    expect(strip(none)).toBe(strip(cold));
    expect(cold.stats.extractCacheHits).toBe(0);
    expect(cold.stats.extractCacheMisses).toBe(cold.stats.files);
    expect(warm.stats.extractCacheHits).toBe(cold.stats.files);
    expect(warm.stats.extractCacheMisses).toBe(0);
    expect(none.stats.extractCacheHits).toBe(0);
  });

  it('the contract entry point `buildGraph(root, profile)` returns the same graph', async () => {
    const g = await buildGraph(FIXTURE, profileRepo(FIXTURE));
    const r = await buildIndex(FIXTURE, undefined, { cacheDir: tmp(), now: NOW });
    expect(g.version).toBe(r.graph.version);
    expect(g.nodes).toEqual(r.graph.nodes);
  });
});

describe('graphVersion (SPEC §7)', () => {
  it('depends on node ids, edge keys and file hashes, and nothing else', () => {
    const base = graphVersion(['a', 'b'], ['a|calls|b'], [{ path: 'x.ts', hash: '1' }]);
    expect(graphVersion(['a', 'b'], ['a|calls|b'], [{ path: 'x.ts', hash: '1' }])).toBe(base);
    expect(graphVersion(['a', 'b', 'c'], ['a|calls|b'], [{ path: 'x.ts', hash: '1' }])).not.toBe(base);
    expect(graphVersion(['a', 'b'], [], [{ path: 'x.ts', hash: '1' }])).not.toBe(base);
    expect(graphVersion(['a', 'b'], ['a|calls|b'], [{ path: 'x.ts', hash: '2' }])).not.toBe(base);
    // file order does not matter
    expect(graphVersion([], [], [{ path: 'a', hash: '1' }, { path: 'b', hash: '2' }])).toBe(graphVersion([], [], [{ path: 'b', hash: '2' }, { path: 'a', hash: '1' }]));
  });
});

describe('cache invalidation', () => {
  it('editing one file re-extracts exactly that file and changes the version', async () => {
    const root = copyFixture();
    const cacheDir = tmp();
    const before = await buildIndex(root, undefined, { cacheDir, now: NOW });
    const target = join(root, 'src/utils/money.ts');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nexport const extra = 1;\n');
    const after = await buildIndex(root, undefined, { cacheDir, now: NOW });
    expect(after.stats.extractCacheMisses).toBe(1);
    expect(after.stats.extractCacheHits).toBe(before.stats.files - 1);
    expect(after.graph.version).not.toBe(before.graph.version);
    expect(after.graph.nodes.some((n) => n.name === 'extra')).toBe(true);
  });

  it('adding a file changes the repo file set, which is part of every key: everything is re-extracted (resolution may change)', async () => {
    const root = copyFixture();
    const cacheDir = tmp();
    await buildIndex(root, undefined, { cacheDir, now: NOW });
    writeFileSync(join(root, 'src/utils/new.ts'), 'export const n = 1;\n');
    const after = await buildIndex(root, undefined, { cacheDir, now: NOW });
    expect(after.stats.extractCacheHits).toBe(0);
    expect(after.graph.nodes.some((n) => n.id === 'file:src/utils/new.ts')).toBe(true);
  });
});

describe('robustness', () => {
  it('broken files never fail the build or damage other files', async () => {
    const root = copyFixture();
    writeFileSync(join(root, 'src/broken.ts'), 'export function ( {{{ const = ;\n');
    writeFileSync(join(root, 'src/Broken.vue'), '<template><div></template>\n<script setup lang="ts">const = ;</script>\n');
    const r = await buildIndex(root, undefined, { cacheDir: tmp(), now: NOW });
    expect(r.graph.nodes.some((n) => n.id === 'file:src/broken.ts')).toBe(true);
    expect(r.graph.nodes.some((n) => n.id === 'file:src/Broken.vue')).toBe(true);
    expect(r.graph.nodes.find((n) => n.id === 'sym:src/stores/order.ts#useOrderStore')).toBeDefined();
  });

  it('an empty directory gives an empty graph; oversized files are reported, not fatal', async () => {
    const empty = tmp();
    const r = await buildIndex(empty, undefined, { cacheDir: tmp(), now: NOW });
    expect(r.graph.nodes).toEqual([]);
    expect(r.stats.files).toBe(0);

    const root = tmp();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/big.ts'), 'export const x = 1;\n' + '//'.repeat(600));
    writeFileSync(join(root, 'src/ok.ts'), 'export const y = 2;\n');
    const r2 = await buildIndex(root, undefined, { cacheDir: tmp(), now: NOW, maxBytes: 500 });
    expect(r2.stats.skipped).toEqual([{ path: 'src/big.ts', reason: 'too-large' }]);
    expect(r2.graph.nodes.some((n) => n.id === 'file:src/ok.ts')).toBe(true);
  });
});
