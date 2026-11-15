import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ExtractCtx, FileExtract, SourceFile } from '../contracts.js';
import { discover } from './discover.js';
import { EXTRACTOR_VERSION, buildExtractCtx, ctxHashOf, extractFile } from './extract.js';
import { profileRepo } from './profile.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');

let files: SourceFile[];
let ctx: ExtractCtx;
let all: Map<string, FileExtract>;
beforeAll(async () => {
  const d = await discover(FIXTURE);
  files = d.files;
  ctx = buildExtractCtx(FIXTURE, profileRepo(FIXTURE), files, d.allPaths);
  all = new Map(files.map((f) => [f.path, extractFile(f, ctx)]));
});

const get = (path: string): FileExtract => all.get(path)!;
const node = (path: string, name: string) => get(path).nodes.find((n) => n.name === name);
const refs = (path: string) => get(path).refs.map((r) => `${r.from.split('#')[1] ?? r.from} -${r.kind}-> ${r.targetPath}#${r.targetName}`);

describe('extractFile: contract properties (PROMPTS 055)', () => {
  it('is pure and deterministic, and its output survives a JSON round trip (cacheable)', () => {
    for (const f of files) {
      const again = extractFile(f, ctx);
      expect(again, f.path).toEqual(get(f.path));
      expect(JSON.parse(JSON.stringify(again)), f.path).toEqual(again);
    }
  });

  it('every file yields consistent nodes, edges and chunks', () => {
    for (const f of files) {
      const x = get(f.path);
      const lines = f.content.split('\n').length - (f.content.endsWith('\n') ? 1 : 0);
      const ids = new Set(x.nodes.map((n) => n.id));
      expect(ids.size, `${f.path}: unique node ids`).toBe(x.nodes.length);
      for (const n of x.nodes) {
        expect(n.path).toBe(f.path);
        expect(n.fileHash).toBe(f.hash);
        expect(n.range!.startLine).toBeGreaterThanOrEqual(1);
        expect(n.range!.endLine).toBeLessThanOrEqual(lines);
        expect(n.tokens, n.id).toBeGreaterThan(0);
      }
      for (const e of x.edges.filter((e) => e.kind !== 'imports')) {
        expect(ids.has(e.from) && ids.has(e.to), `${f.path}: ${e.key}`).toBe(true);
      }
      for (const r of x.refs) expect(ids.has(r.from), `${f.path}: ref from ${r.from}`).toBe(true);
      for (const c of x.chunks) {
        expect(ids.has(c.nodeId), `${f.path}: chunk node ${c.nodeId}`).toBe(true);
        expect(c.text).toBe(f.content.split('\n').slice(c.range.startLine - 1, c.range.endLine).join('\n'));
      }
      expect(x.unresolved, f.path).toEqual([]);
    }
  });
});

describe('extractFile: the fixture, file by file', () => {
  it('Pinia store (setup style): store node with members, a contains edge, a util call, chunks owned by the store', () => {
    const p = 'src/stores/order.ts';
    const store = node(p, 'useOrderStore')!;
    expect(store).toMatchObject({ kind: 'store', id: 'sym:src/stores/order.ts#useOrderStore', meta: { storeId: 'order', style: 'setup', exported: true } });
    expect(store.signature).toBe("export const useOrderStore = defineStore('order', …) { state: current, isSubmitting; getters: total; actions: submitOrder, load }");
    expect(get(p).edges.map((e) => `${e.kind}:${e.to}`)).toEqual(['imports:file:src/types/order.ts', 'imports:file:src/utils/money.ts', `contains:${store.id}`]); // type-only imports are dependencies too
    expect(refs(p)).toEqual(['useOrderStore -calls-> src/utils/money.ts#sumMinor']);
    expect(get(p).chunks.map((c) => [c.id, c.nodeId])).toEqual([[`chunk:${p}#useOrderStore#0`, store.id]]);
  });

  it('composable: kind and returned keys; arrow composables too', () => {
    expect(node('src/composables/useSubmit.ts', 'useSubmit')).toMatchObject({ kind: 'composable', meta: { returns: ['isSubmitting', 'run'] } });
    expect(node('src/composables/useFormat.ts', 'useFormat')).toMatchObject({ kind: 'composable' });
  });

  it('SFC with script setup: component node, outgoing refs of every kind, template + script chunks', () => {
    const p = 'src/components/CheckoutButton.vue';
    const c = node(p, 'CheckoutButton')!;
    expect(c).toMatchObject({ kind: 'component', id: 'sym:src/components/CheckoutButton.vue#CheckoutButton', range: { startLine: 1, endLine: 20 } });
    expect(c.signature).toBe('component CheckoutButton { emits: submitted }');
    expect(refs(p).sort()).toEqual([
      'CheckoutButton -emits_to-> src/components/index.ts#BaseButton',
      'CheckoutButton -passes_prop-> src/components/index.ts#BaseButton',
      'CheckoutButton -uses_component-> src/components/index.ts#BaseButton',
      'CheckoutButton -uses_composable-> src/composables/useSubmit.ts#useSubmit',
      'CheckoutButton -uses_store-> src/stores/order.ts#useOrderStore',
    ]);
    expect(get(p).chunks.map((c) => [c.id, c.range.startLine, c.range.endLine])).toEqual([[`chunk:${p}#CheckoutButton#0`, 1, 16], [`chunk:${p}#_template#0`, 18, 20]]);
    expect(get(p).chunks.every((c) => c.nodeId === 'sym:src/components/CheckoutButton.vue#CheckoutButton')).toBe(true);
  });

  it('SFC props, emits and slots reach the node; auto-imported and imported components both resolve', () => {
    expect(node('src/components/BaseButton.vue', 'BaseButton')!.meta).toMatchObject({ props: ['label', 'disabled', 'loading'], emits: ['click'], slots: ['default'] });
    expect(refs('src/views/CheckoutView.vue')).toEqual(
      expect.arrayContaining([
        'CheckoutView -uses_component-> src/components/OrderSummary.vue#default', // auto-import map
        'CheckoutView -uses_component-> src/components/CheckoutButton.vue#default', // static import
      ]),
    );
  });

  it('router file: raw route tables travel in the extract (finalised later by link)', () => {
    const r = get('src/router/index.ts').routes;
    expect(r.map((d) => d.name)).toEqual(['home', 'orders', 'checkout']);
    expect(r[1]!.children.map((d) => d.name)).toEqual(['order-detail']);
    expect(refs('src/router/index.ts')).toContain('routes -calls-> src/views/HomeView.vue#default');
  });

  it('has_type refs and same-file edges come from signatures', () => {
    expect(refs('src/utils/money.ts')).toContain('orderTotal -has_type-> src/types/order.ts#Order');
  });

  it('test file: one test node, no symbols or chunks, tested_by refs recorded on the test side', () => {
    const p = 'tests/checkout.spec.ts';
    const x = get(p);
    expect(x.nodes.map((n) => n.kind)).toEqual(['file', 'test']);
    expect(x.chunks).toEqual([]);
    expect(refs(p)).toEqual(['checkout.spec.ts -tested_by-> src/components/CheckoutButton.vue#default', 'checkout.spec.ts -tested_by-> src/stores/order.ts#useOrderStore']);
  });

  it('config and generated files: file node (and imports) only; ambient maps: nothing', () => {
    expect(get('vite.config.ts').nodes.map((n) => n.kind)).toEqual(['file']);
    expect(get('src/generated/api.gen.ts').nodes.map((n) => n.kind)).toEqual(['file']);
    expect(get('src/generated/api.gen.ts').chunks).toEqual([]);
    expect(all.has('components.d.ts') ? get('components.d.ts') : null).toEqual({ nodes: [], edges: [], refs: [], chunks: [], imports: [], unresolved: [], routes: [] });
  });

  it('imports become file → file edges only for indexed repo files (not packages, not assets)', () => {
    const edges = get('src/main.ts').edges.filter((e) => e.kind === 'imports').map((e) => e.to);
    expect(edges).toEqual(['file:src/App.vue', 'file:src/components/index.ts', 'file:src/router/index.ts']);
  });

  it('barrel files re-export: imports edges to each re-exported component', () => {
    expect(get('src/components/index.ts').edges.filter((e) => e.kind === 'imports').map((e) => e.to)).toEqual([
      'file:src/components/BaseButton.vue',
      'file:src/components/CheckoutButton.vue',
    ]);
  });
});

describe('cache key', () => {
  it('ctxHashOf is stable and changes when the file set or the global registrations change', () => {
    const base = ctxHashOf(ctx);
    expect(ctxHashOf(ctx)).toBe(base);
    expect(ctxHashOf({ ...ctx, allPaths: new Set([...ctx.allPaths, 'src/new.ts']) })).not.toBe(base);
    expect(ctxHashOf({ ...ctx, globals: new Map() })).not.toBe(base);
    expect(ctxHashOf({ ...ctx, allPaths: new Set([...ctx.allPaths].reverse()) })).toBe(base); // order does not matter
    expect(typeof EXTRACTOR_VERSION).toBe('number');
  });
});
