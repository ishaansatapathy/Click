import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FileExtract, ImportRef, SymbolRef } from '../contracts.js';
import type { GraphNode } from '../types.js';
import { discover } from './discover.js';
import { buildExtractCtx, extractFile } from './extract.js';
import { link, type LinkResult } from './link.js';
import { profileRepo } from './profile.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');

let result: LinkResult;
beforeAll(async () => {
  const d = await discover(FIXTURE);
  const ctx = buildExtractCtx(FIXTURE, profileRepo(FIXTURE), d.files, d.allPaths);
  result = link({ extracts: new Map(d.files.map((f) => [f.path, extractFile(f, ctx)])), fileHashes: new Map(d.files.map((f) => [f.path, f.hash])) });
});

const e = (from: string, kind: string, to: string) => result.edges.find((x) => x.from === from && x.kind === kind && x.to === to);
const S = (p: string, n: string) => `sym:${p}#${n}`;

describe('link on the fixture (PROMPTS 056)', () => {
  it('component → store / composable / component, resolving the barrel import to the real component', () => {
    const cb = S('src/components/CheckoutButton.vue', 'CheckoutButton');
    expect(e(cb, 'uses_store', S('src/stores/order.ts', 'useOrderStore'))).toBeDefined();
    expect(e(cb, 'uses_composable', S('src/composables/useSubmit.ts', 'useSubmit'))).toBeDefined();
    const base = S('src/components/BaseButton.vue', 'BaseButton');
    expect(e(cb, 'uses_component', base)).toBeDefined(); // via src/components/index.ts: export { default as BaseButton } from './BaseButton.vue'
    expect(e(cb, 'passes_prop', base)?.meta?.props).toEqual(['label', 'loading', 'disabled']);
  });

  it('emits_to is reversed: the child points at the parent that listens, with the event names', () => {
    const base = S('src/components/BaseButton.vue', 'BaseButton');
    const cb = S('src/components/CheckoutButton.vue', 'CheckoutButton');
    expect(e(base, 'emits_to', cb)?.meta?.events).toEqual(['click']);
    expect(e(cb, 'emits_to', base)).toBeUndefined();
  });

  it('auto-imported components link like imported ones', () => {
    expect(e(S('src/views/HomeView.vue', 'HomeView'), 'uses_component', S('src/components/CartItem.vue', 'CartItem'))).toBeDefined();
    expect(e(S('src/views/CheckoutView.vue', 'CheckoutView'), 'uses_component', S('src/components/OrderSummary.vue', 'OrderSummary'))).toBeDefined();
  });

  it('routes become nodes with joined paths and routes_to edges to components', () => {
    const routes = result.nodes.filter((n) => n.kind === 'route').map((n) => n.id);
    expect(routes).toEqual(['route:/', 'route:/checkout', 'route:/orders', 'route:/orders/:id']);
    expect(e('route:/orders/:id', 'routes_to', S('src/views/OrderDetailView.vue', 'OrderDetailView'))).toBeDefined();
    expect(e('route:/', 'routes_to', S('src/views/HomeView.vue', 'HomeView'))).toBeDefined();
    expect(result.stats.routes).toBe(4);
    expect(e('file:src/router/index.ts', 'contains', 'route:/checkout')).toBeDefined();
  });

  it('tested_by points from the code under test to the test node', () => {
    const t = S('tests/checkout.spec.ts', 'checkout.spec.ts');
    expect(e(S('src/stores/order.ts', 'useOrderStore'), 'tested_by', t)).toBeDefined();
    expect(e(S('src/components/CheckoutButton.vue', 'CheckoutButton'), 'tested_by', t)).toBeDefined();
  });

  it('has_type links a signature to the type node; calls and same-file edges survive', () => {
    expect(e(S('src/utils/money.ts', 'orderTotal'), 'has_type', S('src/types/order.ts', 'Order'))).toBeDefined();
    expect(e(S('src/stores/order.ts', 'useOrderStore'), 'calls', S('src/utils/money.ts', 'sumMinor'))).toBeDefined();
    expect(e(S('src/router/index.ts', 'router'), 'calls', S('src/router/index.ts', 'routes'))).toBeDefined();
  });

  it('every edge connects existing nodes, there are no self-edges, and the output is sorted and deterministic', () => {
    const ids = new Set(result.nodes.map((n) => n.id));
    for (const x of result.edges) {
      expect(ids.has(x.from) && ids.has(x.to), x.key).toBe(true);
      expect(x.from).not.toBe(x.to);
      expect(x.key).toBe(`${x.from}|${x.kind}|${x.to}`);
    }
    expect(result.nodes.map((n) => n.id)).toEqual([...result.nodes.map((n) => n.id)].sort());
    expect(result.edges.map((x) => x.key)).toEqual([...result.edges.map((x) => x.key)].sort());
    expect(result.stats.dropped).toBe(0);
    expect(result.stats.fileFallback).toBe(0);
    expect(result.stats.unresolvedRoutePaths).toEqual([]);
  });

  it('every chunk points at a node', () => {
    const ids = new Set(result.nodes.map((n) => n.id));
    expect(result.chunks.length).toBeGreaterThan(10);
    for (const c of result.chunks) expect(ids.has(c.nodeId), c.id).toBe(true);
  });
});

// ---------------------------------------------------------------- synthetic cases

const node = (path: string, name: string, kind: GraphNode['kind'], meta: Record<string, unknown> = {}): GraphNode => ({
  id: `sym:${path}#${name}`, kind, path, name, range: { startLine: 1, endLine: 1 }, tokens: 1, sigTokens: 0, fileHash: 'h', meta: { exported: true, isDefault: false, ...meta },
});
const fileNode = (path: string): GraphNode => ({ id: `file:${path}`, kind: 'file', path, name: path, range: { startLine: 1, endLine: 1 }, tokens: 1, sigTokens: 0, fileHash: 'h' });
const x = (path: string, nodes: GraphNode[], extra: Partial<FileExtract> = {}): [string, FileExtract] => [path, { nodes: [fileNode(path), ...nodes], edges: [], refs: [], chunks: [], imports: [], unresolved: [], routes: [], ...extra }];
const reexport = (spec: string, path: string, names: ImportRef['names']): ImportRef => ({ spec, resolved: { kind: 'local', path }, kind: 'reexport', names });
const ref = (from: string, kind: SymbolRef['kind'], targetPath: string, targetName: string): SymbolRef => ({ from, kind, targetPath, targetName });

describe('link rules', () => {
  const user = node('src/user.ts', 'caller', 'function');

  it('follows re-export chains: named, renamed default, export *, namespace; stops after 3 hops', () => {
    const target = node('src/deep.ts', 'thing', 'function');
    const comp = node('src/Cmp.vue', 'Cmp', 'component');
    const extracts = new Map([
      x('src/user.ts', [user], { refs: [ref(user.id, 'calls', 'src/b1.ts', 'thing'), ref(user.id, 'calls', 'src/b1.ts', 'Alias'), ref(user.id, 'calls', 'src/b1.ts', 'Cmp'), ref(user.id, 'calls', 'src/h1.ts', 'thing')] }),
      x('src/b1.ts', [], { imports: [reexport('./b2', 'src/b2.ts', [{ imported: '*', local: '*', typeOnly: false }]), reexport('./deep', 'src/deep.ts', [{ imported: 'thing', local: 'Alias', typeOnly: false }]), reexport('./Cmp.vue', 'src/Cmp.vue', [{ imported: 'default', local: 'Cmp', typeOnly: false }])] }),
      x('src/b2.ts', [], { imports: [reexport('./deep', 'src/deep.ts', [{ imported: '*', local: '*', typeOnly: false }])] }),
      x('src/deep.ts', [target]),
      x('src/Cmp.vue', [comp]),
      // four hops away: h1 → h2 → h3 → h4 → deep
      x('src/h1.ts', [], { imports: [reexport('./h2', 'src/h2.ts', [{ imported: '*', local: '*', typeOnly: false }])] }),
      x('src/h2.ts', [], { imports: [reexport('./h3', 'src/h3.ts', [{ imported: '*', local: '*', typeOnly: false }])] }),
      x('src/h3.ts', [], { imports: [reexport('./h4', 'src/h4.ts', [{ imported: '*', local: '*', typeOnly: false }])] }),
      x('src/h4.ts', [], { imports: [reexport('./deep', 'src/deep.ts', [{ imported: '*', local: '*', typeOnly: false }])] }),
    ]);
    const r = link({ extracts, fileHashes: new Map() });
    const to = r.edges.filter((e) => e.from === user.id).map((e) => e.to).sort();
    expect(to).toEqual([target.id, comp.id, target.id, 'file:src/h1.ts'].sort().filter((v, i, a) => a.indexOf(v) === i)); // thing (twice, deduped), Cmp, and h1's file fallback
    expect(r.stats.fileFallback).toBe(1); // 4 hops is too deep: falls back to the file node
    expect(r.stats.resolved).toBe(3);
  });

  it('re-derives the edge kind from the target node', () => {
    const store = node('src/s.ts', 'useAuth', 'store');
    const comp = node('src/c.ts', 'useClock', 'composable');
    const plain = node('src/p.ts', 'useStoreFoo', 'function'); // looks like a store, is not
    const extracts = new Map([
      x('src/user.ts', [user], { refs: [ref(user.id, 'calls', 'src/s.ts', 'useAuth'), ref(user.id, 'calls', 'src/c.ts', 'useClock'), ref(user.id, 'uses_store', 'src/p.ts', 'useStoreFoo')] }),
      x('src/s.ts', [store]), x('src/c.ts', [comp]), x('src/p.ts', [plain]),
    ]);
    expect(link({ extracts, fileHashes: new Map() }).edges.map((e) => `${e.kind}:${e.to.split('#')[1]}`)).toEqual(['calls:useStoreFoo', 'uses_composable:useClock', 'uses_store:useAuth']);
  });

  it('has_type keeps only real types; namespace/side-effect targets use the file node; missing targets are counted, not thrown', () => {
    const type = node('src/t.ts', 'Order', 'type');
    const fn = node('src/f.ts', 'helper', 'function');
    const extracts = new Map([
      x('src/user.ts', [user], { refs: [ref(user.id, 'has_type', 'src/t.ts', 'Order'), ref(user.id, 'has_type', 'src/f.ts', 'helper'), ref(user.id, 'calls', 'src/f.ts', '*'), ref(user.id, 'calls', 'src/ghost.ts', 'x'), ref('sym:nope#nope', 'calls', 'src/f.ts', 'helper')] }),
      x('src/t.ts', [type]), x('src/f.ts', [fn]),
    ]);
    const r = link({ extracts, fileHashes: new Map() });
    expect(r.edges.map((e) => `${e.kind}:${e.to}`).sort()).toEqual(['calls:file:src/f.ts', 'has_type:sym:src/t.ts#Order']);
    expect(r.stats).toMatchObject({ refs: 5, resolved: 2, fileFallback: 0, dropped: 3, droppedByReason: { 'not-a-type': 1, 'target-not-found': 1, 'source-missing': 1 } });
  });

  it('merges props and events across repeated refs and drops self-edges and dangling imports', () => {
    const a = node('src/a.vue', 'A', 'component');
    const b = node('src/b.vue', 'B', 'component');
    const p = (props: string[]): SymbolRef => ({ ...ref(a.id, 'passes_prop', 'src/b.vue', 'default'), meta: { source: 'ast', props } });
    const extracts = new Map([
      x('src/a.vue', [a], { refs: [p(['x']), p(['y', 'x']), ref(a.id, 'uses_component', 'src/a.vue', 'default')], edges: [{ key: 'file:src/a.vue|imports|file:src/gone.ts', from: 'file:src/a.vue', to: 'file:src/gone.ts', kind: 'imports' }] }),
      x('src/b.vue', [b]),
    ]);
    const r = link({ extracts, fileHashes: new Map() });
    expect(r.edges.find((e) => e.kind === 'passes_prop')?.meta?.props).toEqual(['x', 'y']);
    expect(r.edges.some((e) => e.from === e.to)).toBe(false);
    expect(r.edges.some((e) => e.kind === 'imports')).toBe(false);
  });

  it('an imported route path constant is looked up in the other file', () => {
    const home = node('src/Home.vue', 'Home', 'component');
    const konst = node('src/paths.ts', 'HOME_PATH', 'function', { value: '/home' });
    const routes: FileExtract['routes'] = [{ path: { kind: 'ref', local: 'HOME_PATH', targetPath: 'src/paths.ts', exportName: 'HOME_PATH' }, range: { startLine: 1, endLine: 1 }, component: { path: 'src/Home.vue', exportName: 'default' }, lazy: false, children: [] }];
    const r = link({ extracts: new Map([x('src/router.ts', [], { routes }), x('src/paths.ts', [konst]), x('src/Home.vue', [home])]), fileHashes: new Map([['src/router.ts', 'rh']]) });
    expect(r.nodes.find((n) => n.kind === 'route')).toMatchObject({ id: 'route:/home', fileHash: 'rh' });
    expect(r.edges.some((e) => e.from === 'route:/home' && e.kind === 'routes_to' && e.to === home.id)).toBe(true);
    expect(r.stats.unresolvedRoutePaths).toEqual([]);
  });
});
