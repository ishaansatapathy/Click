import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIndex, type IndexState } from './build.js';
import { applyDelta, diffGraphs, needsFullRebuild, updateIndex, type ChangedPath } from './incremental.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');
const NOW = () => new Date('2026-11-15T10:00:00.000Z');

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'click-incr-'));
  cpSync(FIXTURE, root, { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const abs = (p: string) => join(root, p);
const read = (p: string) => readFileSync(abs(p), 'utf8');
const write = (p: string, text: string) => {
  mkdirSync(dirname(abs(p)), { recursive: true });
  writeFileSync(abs(p), text);
};
const change = (p: string, status: ChangedPath['status'] = 'M'): ChangedPath => ({ path: p, status });
const fresh = () => buildIndex(root, undefined, { cache: false, now: NOW });
const snapshot = (s: Pick<IndexState, 'graph' | 'chunks'>) => JSON.stringify({ g: s.graph, c: s.chunks });

function allFiles(dir = ''): string[] {
  return readdirSync(abs(dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : allFiles(join(dir, e.name))) : [join(dir, e.name).replace(/\\/g, '/')]));
}

describe('updateIndex: targeted behaviour (PROMPTS 058)', () => {
  let state: IndexState;
  beforeAll(async () => {
    state = (await fresh()).state;
  });

  it('no changes: empty delta, same version', async () => {
    const r = await updateIndex(state, []);
    expect(r.delta).toMatchObject({ upsertNodes: [], upsertEdges: [], upsertChunks: [], deleteNodeIds: [], deleteEdgeKeys: [], deleteChunkIds: [], fromVersion: state.graph.version });
    expect(r.state.graph.version).toBe(state.graph.version);
    expect(r.stats.reExtracted).toBe(0);
  });

  it('editing one file re-extracts only that file; its new symbol is the delta', async () => {
    write('src/utils/money.ts', read('src/utils/money.ts') + '\nexport const taxRate = 0.18;\n');
    const r = await updateIndex(state, [change('src/utils/money.ts')]);
    expect(r.stats).toMatchObject({ changed: 1, reExtracted: 1, dependents: 0, fullRebuild: false });
    expect(r.delta.upsertNodes.map((n) => n.id)).toEqual(expect.arrayContaining(['sym:src/utils/money.ts#taxRate', 'file:src/utils/money.ts']));
    expect(r.delta.deleteNodeIds).toEqual([]);
    expect(r.stats.ms.total).toBeLessThan(2000); // SPEC: a one-file change re-indexes in seconds
    expect(snapshot(r.state)).toBe(snapshot((await fresh()).state));
    state = r.state;
  });

  it('deleting a file re-extracts the files that imported it (their imports no longer resolve)', async () => {
    unlinkSync(abs('src/utils/money.ts'));
    const r = await updateIndex(state, [change('src/utils/money.ts', 'D')]);
    expect(r.stats.dependents).toBeGreaterThan(0);
    expect(r.delta.deleteNodeIds).toEqual(expect.arrayContaining(['file:src/utils/money.ts', 'sym:src/utils/money.ts#sumMinor']));
    expect(r.state.extracts.has('src/utils/money.ts')).toBe(false);
    expect(snapshot(r.state)).toBe(snapshot((await fresh()).state));
    state = r.state;
  });

  it('adding a file that an unresolved import was waiting for re-extracts only the importer', async () => {
    write('src/views/Pic.vue', '<script setup lang="ts">\nimport logo from "./logo.png"\n</script>\n<template><img :src="logo" /></template>\n');
    let r = await updateIndex(state, [change('src/views/Pic.vue', 'A')]);
    expect(r.state.extracts.get('src/views/Pic.vue')!.unresolved).toEqual(['./logo.png']);
    write('src/views/logo.png', 'not really a png');
    r = await updateIndex(r.state, [change('src/views/logo.png', 'A')]);
    expect(r.stats).toMatchObject({ reExtracted: 1, dependents: 1 });
    expect(r.state.extracts.get('src/views/Pic.vue')!.unresolved).toEqual([]);
    expect(snapshot(r.state)).toBe(snapshot((await fresh()).state));
    state = r.state;
  });

  it('a change outside the repo is ignored; a profile input forces a full rebuild with a correct delta', async () => {
    const outside = await updateIndex(state, [change('../elsewhere/x.ts')]);
    expect(outside.stats.changed).toBe(0);
    write('tsconfig.json', read('tsconfig.json') + '\n');
    const r = await updateIndex(state, [change('tsconfig.json')]);
    expect(r.stats).toMatchObject({ fullRebuild: true });
    expect(r.stats.reason).toContain('tsconfig.json');
    expect(snapshot(r.state)).toBe(snapshot((await fresh()).state));
  });

  it('needsFullRebuild recognises profile inputs only', () => {
    for (const p of ['tsconfig.json', 'packages/a/tsconfig.app.json', 'vite.config.ts', 'vitest.config.mts', 'components.d.ts', 'src/auto-imports.d.ts', 'package.json']) expect(needsFullRebuild(p), p).toBe(true);
    for (const p of ['src/main.ts', 'src/App.vue', 'src/env.d.ts', 'tests/vite.config.spec.ts']) expect(needsFullRebuild(p), p).toBe(false);
  });
});

describe('diffGraphs / applyDelta', () => {
  it('applyDelta(prev, diff(prev, next)) reproduces next exactly, with the same version', async () => {
    const before = await fresh();
    write('src/composables/useDiff.ts', "import { useCartStore } from '@/stores/cart';\nexport function useDiff() { return useCartStore(); }\n");
    const after = await fresh();
    const delta = diffGraphs(before.state, after.state);
    expect(delta.upsertNodes.map((n) => n.id)).toContain('sym:src/composables/useDiff.ts#useDiff');
    expect(delta.fromVersion).toBe(before.graph.version);
    const applied = applyDelta(before.graph, delta);
    expect(JSON.stringify(applied)).toBe(JSON.stringify(after.graph));
    unlinkSync(abs('src/composables/useDiff.ts'));
  });
});

// ---------------------------------------------------------------- the property test

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('property: incremental update == full rebuild after random edits', () => {
  it('30 rounds of random edits (add, edit, delete, rename, shadow, router, globals, profile)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'click-prop-'));
    cpSync(FIXTURE, dir, { recursive: true });
    const R = rng(1337);
    const pick = <T>(xs: T[]): T => xs[Math.floor(R() * xs.length)]!;
    const p = (rel: string) => join(dir, rel);
    const rd = (rel: string) => readFileSync(p(rel), 'utf8');
    const wr = (rel: string, text: string) => {
      mkdirSync(dirname(p(rel)), { recursive: true });
      writeFileSync(p(rel), text);
    };
    let n = 0;
    const added = new Set<string>();

    const listSrc = () => {
      const out: string[] = [];
      const walk = (d: string) => {
        for (const e of readdirSync(p(d), { withFileTypes: true })) {
          const rel = d ? `${d}/${e.name}` : e.name;
          if (e.isDirectory()) walk(rel);
          else if (rel.startsWith('src/') && /\.(ts|vue)$/.test(rel) && !rel.endsWith('.d.ts')) out.push(rel);
        }
      };
      walk('src');
      return out;
    };

    // each op returns the paths it touched (status derived from existence afterwards)
    const ops: Record<string, () => string[]> = {
      appendExport() {
        const f = pick(listSrc().filter((x) => x.endsWith('.ts') && !x.includes('generated')));
        wr(f, rd(f) + `\nexport const extra${++n} = ${n};\n`);
        return [f];
      },
      editVue() {
        const f = pick(listSrc().filter((x) => x.endsWith('.vue') && rd(x).includes('</template>')));
        wr(f, rd(f).replace(/<\/template>(?![\s\S]*<\/template>)/, `<!-- edit ${++n} --></template>`));
        return [f];
      },
      addComposable() {
        const f = `src/composables/useNew${++n}.ts`;
        wr(f, `import { useCartStore } from '@/stores/cart';\nimport { useFormat } from './useFormat';\nexport function useNew${n}() { const cart = useCartStore(); const { price } = useFormat(); return { cart, price }; }\n`);
        added.add(f);
        return [f];
      },
      addView() {
        const f = `src/views/Added${++n}.vue`;
        wr(f, `<script setup lang="ts">\nimport { useOrderStore } from '@/stores/order';\nconst order = useOrderStore();\n</script>\n<template><cart-item :item="order.current" @remove="order.load" /><OrderSummary v-if="order.current" :order="order.current" /></template>\n`);
        added.add(f);
        return [f];
      },
      deleteSomething() {
        const candidates = [...added].filter((x) => existsSync(p(x)));
        const f = candidates.length && R() < 0.6 ? pick(candidates) : pick(listSrc().filter((x) => x !== 'src/main.ts'));
        unlinkSync(p(f));
        return [f];
      },
      shadowBarrel() {
        // '@/components' resolves to components/index.ts until a components.ts appears next to it
        const f = 'src/components.ts';
        if (existsSync(p(f))) unlinkSync(p(f));
        else wr(f, 'export const BaseButton = 1;\nexport const CheckoutButton = 2;\n');
        return [f];
      },
      editRouter() {
        const f = 'src/router/index.ts';
        if (!existsSync(p(f))) return [];
        const s = rd(f);
        wr(f, s.includes("path: '/added'") ? s.replace(/\{ path: '\/added'[^\n]*\n\s*/, '') : s.replace("{ path: '/checkout'", "{ path: '/added', name: 'added', component: () => import('@/views/OrdersView.vue') },\n  { path: '/checkout'"));
        return [f];
      },
      swapGlobal() {
        const f = 'src/main.ts';
        if (!existsSync(p(f))) return [];
        const s = rd(f);
        wr(f, s.includes("'BaseButton', CheckoutButton") ? s.replace("'BaseButton', CheckoutButton", "'BaseButton', BaseButton") : s.replace("import { BaseButton } from '@/components'", "import { BaseButton, CheckoutButton } from '@/components'").replace("'BaseButton', BaseButton", "'BaseButton', CheckoutButton"));
        return [f];
      },
      renameExport() {
        const f = 'src/utils/money.ts';
        if (!existsSync(p(f))) return [];
        const s = rd(f);
        wr(f, s.includes('function formatPrice2(') ? s.replace('function formatPrice2(', 'function formatPrice(') : s.replace('function formatPrice(', 'function formatPrice2('));
        return [f];
      },
      touchProfile() {
        const f = 'components.d.ts';
        wr(f, rd(f) + `\n// touched ${++n}\n`);
        return [f];
      },
    };

    // forced coverage first, then random
    const schedule = ['shadowBarrel', 'shadowBarrel', 'swapGlobal', 'touchProfile', 'deleteSomething', 'editRouter', 'renameExport'];
    let state = (await buildIndex(dir, undefined, { cache: false, now: NOW })).state;
    const seen = { dependents: 0, full: 0, rounds: 0, upserts: 0, deletes: 0 };

    for (let round = 0; round < 30; round++) {
      const names = round < schedule.length ? [schedule[round]!] : Array.from({ length: 1 + Math.floor(R() * 3) }, () => pick(Object.keys(ops)));
      const touched = [...new Set(names.flatMap((nm) => ops[nm]!()))];
      const changes: ChangedPath[] = touched.map((t) => ({ path: relative(dir, p(t)).replace(/\\/g, '/'), status: existsSync(p(t)) ? 'M' : 'D' }));
      const r = await updateIndex(state, changes, { now: NOW, cache: false });
      const full = await buildIndex(dir, undefined, { cache: false, now: NOW });

      expect(r.state.graph.nodes.map((x) => x.id), `round ${round} ${names}: nodes`).toEqual(full.graph.nodes.map((x) => x.id));
      expect(r.state.graph.edges.map((x) => x.key), `round ${round} ${names}: edges`).toEqual(full.graph.edges.map((x) => x.key));
      expect(snapshot(r.state), `round ${round} ${names}: full graph + chunks`).toBe(snapshot(full.state));
      expect(JSON.stringify(applyDelta(state.graph, r.delta)), `round ${round} ${names}: applyDelta`).toBe(JSON.stringify(full.graph));

      seen.dependents += r.stats.dependents;
      seen.full += r.stats.fullRebuild ? 1 : 0;
      seen.upserts += r.delta.upsertNodes.length;
      seen.deletes += r.delta.deleteNodeIds.length;
      seen.rounds++;
      state = r.state;
    }
    // the run must have exercised the interesting paths, or the equality above proves little
    expect(seen.rounds).toBe(30);
    expect(seen.dependents).toBeGreaterThan(0);
    expect(seen.full).toBeGreaterThan(0);
    expect(seen.upserts).toBeGreaterThan(20);
    expect(seen.deletes).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});

void allFiles;
