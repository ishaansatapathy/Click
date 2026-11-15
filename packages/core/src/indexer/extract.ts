// SPEC §5.6 / PROMPTS 055: everything the indexer knows about ONE file, as a pure function of (file, ctx).
// No I/O, no clock, no randomness: the same input always gives deep-equal output, so results can be cached by
// (file hash, EXTRACTOR_VERSION, ctx hash) and re-extracted selectively (058).
// Cross-file edges leave as SymbolRefs for link.ts; edges inside the file are final.

import { posix } from 'node:path';
import type { ExtractCtx, ExtractFile, FileExtract, GlobalComponents, ImportRef, SourceFile, SymbolRef } from '../contracts.js';
import type { ChunkRecord, GraphEdge, GraphNode, LineRange, NodeKind } from '../types.js';
import { hashOf } from '../util/hash.js';
import { componentName, edgeKey, fileId, symId } from '../util/ids.js';
import { countTokens } from '../util/tokens.js';
import { chunkFile, statementBoundaries, topLevelBoundaries, type ChunkUnit } from './chunk.js';
import { extractComposables } from './composables.js';
import { isIndexedPath } from './discover.js';
import { extractPiniaStores, type PiniaStore } from './pinia.js';
import type { RepoProfile } from './profile.js';
import { makeResolver, type Resolver } from './resolve.js';
import { extractRoutes } from './router.js';
import { extractTestFile } from './tests.js';
import { extractTsImports, type RawImport } from './ts-imports.js';
import { parseTs } from './ts-parse.js';
import { capSignature, extractTsSymbols, type TsSymbol } from './ts-symbols.js';
import { extractTypeEdges } from './types-edges.js';
import { extractUsages, templateValueRefs } from './usages.js';
import { extractVueMeta, type ComponentMeta } from './vue-meta.js';
import { parseVueSfc } from './vue-sfc.js';
import { extractTemplateUsages, findGlobalRegistrations, templateRefs } from './vue-template.js';

/** Bump whenever extraction output changes: it is part of the cache key. */
export const EXTRACTOR_VERSION = 1;

// ---------------------------------------------------------------- ctx

/** Everything about the profile that can change extraction. `root` (a machine path) and `counts` are excluded. */
export const profileHashOf = (p: RepoProfile): string => hashOf({ tsconfigPaths: p.tsconfigPaths, baseUrl: p.baseUrl, viteAliases: p.viteAliases, autoImport: p.autoImport });

/** Hash of everything in ctx that affects extraction output: the cache key for per-file results. */
export function ctxHashOf(ctx: ExtractCtx): string {
  const globals = [...ctx.globals].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return hashOf({ profile: ctx.profileHash, paths: hashOf([...ctx.allPaths].sort()), globals });
}

/** Global registrations found in ONE file: `app.component('Name', Comp)`. Null for files that cannot contain any (cheap text pre-filter). */
export type Registrations = ReturnType<typeof findGlobalRegistrations>;
export function fileRegistrations(f: SourceFile, resolve: Resolver): Registrations | null {
  if (f.path.endsWith('.vue') || f.class !== 'src' || !f.content.includes('.component(')) return null;
  const sf = parseTs(f.content, f.path);
  const found = findGlobalRegistrations(sf, extractTsImports(sf), resolve, f.path);
  return found.size > 0 ? found : null;
}

export function collectRegistrations(files: readonly SourceFile[], profile: RepoProfile, allPaths: ReadonlySet<string>): Map<string, Registrations> {
  const resolve = makeResolver(profile, allPaths);
  const out = new Map<string, Registrations>();
  for (const f of files) {
    const r = fileRegistrations(f, resolve);
    if (r) out.set(f.path, r);
  }
  return out;
}

/** Merge per-file registrations into one map. First file (by path order) wins a name: deterministic, and independent of discovery order. */
export function mergeRegistrations(regs: ReadonlyMap<string, Registrations>): GlobalComponents {
  const out = new Map<string, Registrations extends Map<string, infer V> ? V : never>();
  for (const path of [...regs.keys()].sort()) for (const [name, target] of regs.get(path)!) if (!out.has(name)) out.set(name, target);
  return out;
}

/** Global registrations across the repo's TS files. */
export const collectGlobals = (files: readonly SourceFile[], profile: RepoProfile, allPaths: ReadonlySet<string>): GlobalComponents =>
  mergeRegistrations(collectRegistrations(files, profile, allPaths));

export function makeExtractCtx(root: string, profile: RepoProfile, allPaths: ReadonlySet<string>, globals: GlobalComponents): ExtractCtx {
  return { root, profile, profileHash: profileHashOf(profile), allPaths, globals };
}

export function buildExtractCtx(root: string, profile: RepoProfile, files: readonly SourceFile[], allPaths: Iterable<string>): ExtractCtx {
  const paths = new Set(allPaths);
  return makeExtractCtx(root, profile, paths, collectGlobals(files, profile, paths));
}

// The resolver is built once per (profile, path set), not once per file.
const resolvers = new WeakMap<ReadonlySet<string>, { profile: RepoProfile; resolve: Resolver }>();
function resolverFor(ctx: ExtractCtx): Resolver {
  const hit = resolvers.get(ctx.allPaths);
  if (hit && hit.profile === ctx.profile) return hit.resolve;
  const resolve = makeResolver(ctx.profile, ctx.allPaths);
  resolvers.set(ctx.allPaths, { profile: ctx.profile, resolve });
  return resolve;
}

// ---------------------------------------------------------------- node helpers

interface Src {
  path: string;
  lines: string[];
  fileHash: string;
}

const lineCount = (content: string): number => (content === '' ? 1 : content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length);

function mkNode(src: Src, kind: NodeKind, id: string, name: string, range: LineRange, extra: { signature?: string; doc?: string; meta?: Record<string, unknown> } = {}): GraphNode {
  const body = src.lines.slice(range.startLine - 1, range.endLine).join('\n');
  const node: GraphNode = { id, kind, path: src.path, name, range, tokens: countTokens(body), sigTokens: extra.signature ? countTokens(extra.signature) : 0, fileHash: src.fileHash };
  if (extra.signature) node.signature = extra.signature;
  if (extra.doc) node.doc = extra.doc;
  if (extra.meta) node.meta = extra.meta;
  return node;
}

const TYPE_SYMBOL_KINDS = new Set<TsSymbol['kind']>(['interface', 'type', 'enum', 'class']);

class Acc {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();
  readonly refs = new Map<string, SymbolRef>();
  chunks: ChunkRecord[] = [];
  imports: ImportRef[] = [];
  unresolved: string[] = [];
  routes: FileExtract['routes'] = [];

  node(n: GraphNode): void {
    if (!this.nodes.has(n.id)) this.nodes.set(n.id, n);
  }
  edge(from: string, kind: GraphEdge['kind'], to: string, meta?: GraphEdge['meta']): void {
    const key = edgeKey(from, kind, to);
    if (!this.edges.has(key)) this.edges.set(key, { key, from, to, kind, ...(meta ? { meta } : {}) });
  }
  edgeRaw(e: GraphEdge): void {
    if (!this.edges.has(e.key)) this.edges.set(e.key, e);
  }
  ref(r: SymbolRef): void {
    const key = `${r.from}|${r.kind}|${r.targetPath}#${r.targetName}`;
    const prev = this.refs.get(key);
    if (!prev) this.refs.set(key, r);
    else if (r.meta?.props || r.meta?.events) {
      // merge names from repeated usages
      const merge = (a?: string[], b?: string[]) => [...new Set([...(a ?? []), ...(b ?? [])])];
      prev.meta = { ...prev.meta, ...(r.meta.props || prev.meta?.props ? { props: merge(prev.meta?.props, r.meta.props) } : {}), ...(r.meta.events || prev.meta?.events ? { events: merge(prev.meta?.events, r.meta.events) } : {}) };
    }
  }
  result(): FileExtract {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      refs: [...this.refs.values()],
      chunks: this.chunks,
      imports: this.imports,
      unresolved: [...new Set(this.unresolved)].sort(),
      routes: this.routes,
    };
  }
}

/** Resolve every import once: ImportRefs, `imports` edges to indexed repo files, and the unresolved list. */
function handleImports(acc: Acc, raw: RawImport[], resolve: Resolver, path: string, fileNodeId: string): void {
  for (const imp of raw) {
    const resolved = resolve(imp.spec, path);
    acc.imports.push({ spec: imp.spec, resolved, kind: imp.kind, names: imp.names });
    if (resolved.kind === 'unresolved') acc.unresolved.push(imp.spec);
    if (resolved.kind === 'local' && resolved.path !== path && isIndexedPath(resolved.path)) acc.edge(fileNodeId, 'imports', fileId(resolved.path), { source: 'ast' });
  }
}

// ---------------------------------------------------------------- per kind of file

function extractTs(file: SourceFile, ctx: ExtractCtx, src: Src, acc: Acc, fileNode: GraphNode): void {
  const resolve = resolverFor(ctx);
  const sf = parseTs(file.content, file.path);
  const raw = extractTsImports(sf);
  const symbols = extractTsSymbols(sf);
  const stores = new Map<string, PiniaStore>(extractPiniaStores(sf).map((s) => [s.name, s]));
  const composables = new Map(extractComposables(sf, symbols).map((c) => [c.name, c]));
  handleImports(acc, raw, resolve, file.path, fileNode.id);

  for (const s of symbols) {
    const id = symId(file.path, s.name);
    const store = stores.get(s.name);
    const composable = composables.get(s.name);
    const kind: NodeKind = store ? 'store' : composable ? 'composable' : TYPE_SYMBOL_KINDS.has(s.kind) ? 'type' : 'function';
    const meta: Record<string, unknown> = { symbolKind: s.kind, exported: s.exported, isDefault: s.isDefault };
    if (s.parent) meta.parent = s.parent;
    if (s.callee) meta.callee = s.callee;
    if (s.value !== undefined) meta.value = s.value;
    if (composable) meta.returns = composable.returns;
    let signature = s.signature;
    if (store) {
      Object.assign(meta, { storeId: store.id, style: store.style, state: store.state, getters: store.getters, actions: store.actions });
      if (store.dynamic) meta.dynamic = true;
      const members = [store.state.length ? `state: ${store.state.join(', ')}` : '', store.getters.length ? `getters: ${store.getters.join(', ')}` : '', store.actions.length ? `actions: ${store.actions.join(', ')}` : ''].filter(Boolean).join('; ');
      signature = capSignature(`${s.signature}${members ? ` { ${members} }` : store.dynamic ? ' { dynamic members }' : ''}`);
    }
    acc.node(mkNode(src, kind, id, s.name, s.range, { signature, ...(s.doc ? { doc: s.doc } : {}), meta }));
    acc.edge(fileNode.id, 'contains', id, { source: 'ast' });
  }

  const usages = extractUsages(sf, { path: file.path, resolve, imports: raw, symbols, ownerDefault: fileNode.id });
  usages.refs.forEach((r) => acc.ref(r));
  usages.edges.forEach((e) => acc.edgeRaw(e));
  const types = extractTypeEdges({ path: file.path, resolve, imports: raw, symbols });
  types.refs.forEach((r) => acc.ref(r));
  types.edges.forEach((e) => acc.edgeRaw(e));
  acc.routes = extractRoutes(sf, { path: file.path, imports: raw, resolve });

  const units: ChunkUnit[] = symbols
    .filter((s) => s.kind !== 'method')
    .map((s) => ({ nodeId: symId(file.path, s.name), name: s.name, range: s.range, boundaries: statementBoundaries(sf, s.range) }));
  acc.chunks = chunkFile({ path: file.path, content: file.content, fallbackNodeId: fileNode.id, units });
}

function componentSignature(name: string, meta: ComponentMeta): string {
  const parts = [meta.props.length ? `props: ${meta.props.join(', ')}` : '', meta.emits.length ? `emits: ${meta.emits.join(', ')}` : '', meta.slots.length ? `slots: ${meta.slots.join(', ')}` : '', meta.models.length ? `v-model: ${meta.models.join(', ')}` : ''].filter(Boolean);
  return capSignature(`component ${name}${parts.length ? ` { ${parts.join('; ')} }` : ''}`);
}

function extractVue(file: SourceFile, ctx: ExtractCtx, src: Src, acc: Acc, fileNode: GraphNode): void {
  const resolve = resolverFor(ctx);
  const sfc = parseVueSfc(file.content, file.path);
  const meta = extractVueMeta(sfc);
  const compId = symId(file.path, sfc.componentName);
  handleImports(acc, sfc.imports, resolve, file.path, fileNode.id);

  acc.node(mkNode(src, 'component', compId, sfc.componentName, sfc.range, { signature: componentSignature(sfc.componentName, meta), meta: { ...meta } }));
  acc.edge(fileNode.id, 'contains', compId, { source: 'ast' });

  // Script usages: the component owns all top-level code, so inner helpers do not become nodes.
  for (const script of sfc.scripts) {
    const u = extractUsages(script.sf, { path: file.path, resolve, imports: sfc.imports, symbols: [], ownerDefault: compId });
    u.refs.forEach((r) => acc.ref(r));
  }
  // Template: component tags, props, listeners, and imported functions used only in the template.
  const usages = extractTemplateUsages(sfc, { path: file.path, resolve, globals: ctx.globals, autoImport: ctx.profile.autoImport.components });
  templateRefs(compId, usages).forEach((r) => acc.ref(r));
  if (sfc.template) templateValueRefs(sfc.template.source, sfc.imports, resolve, file.path, compId).forEach((r) => acc.ref(r));

  const units: ChunkUnit[] = sfc.scripts.map((s) => ({ nodeId: compId, name: sfc.componentName, range: s.range, boundaries: topLevelBoundaries(s.sf, s.lineOffset) }));
  const template: ChunkUnit | undefined = sfc.template
    ? { nodeId: compId, name: '_template', range: sfc.template.range, boundaries: sfc.template.ast.children.filter((c) => c.type === 1).map((c) => c.loc.start.line) }
    : undefined;
  acc.chunks = chunkFile({ path: file.path, content: file.content, fallbackNodeId: compId, units, ...(template ? { template } : {}) });
}

function extractTest(file: SourceFile, ctx: ExtractCtx, src: Src, acc: Acc, fileNode: GraphNode): void {
  const resolve = resolverFor(ctx);
  const sf = parseTs(file.content, file.path);
  const raw = extractTsImports(sf);
  handleImports(acc, raw, resolve, file.path, fileNode.id);
  const t = extractTestFile(sf, file.path, raw, resolve);
  acc.node(mkNode(src, 'test', t.nodeId, t.name, fileNode.range!, { signature: t.signature, meta: { describes: t.describes, cases: t.cases } }));
  acc.edge(fileNode.id, 'contains', t.nodeId, { source: 'ast' });
  t.refs.forEach((r) => acc.ref(r));
}

// ---------------------------------------------------------------- entry point

const EMPTY: FileExtract = { nodes: [], edges: [], refs: [], chunks: [], imports: [], unresolved: [], routes: [] };

export const extractFile: ExtractFile = (file, ctx) => {
  if (file.class === 'generated' && file.path.endsWith('.d.ts')) return structuredClone(EMPTY); // ambient maps: profile only
  const src: Src = { path: file.path, lines: file.content.split('\n'), fileHash: file.hash };
  const range = { startLine: 1, endLine: lineCount(file.content) };
  const fileNode = mkNode(src, 'file', fileId(file.path), posix.basename(file.path), range, { meta: { class: file.class, lang: posix.extname(file.path).slice(1) } });
  const acc = new Acc();
  acc.node(fileNode);

  if (file.class === 'generated') return acc.result(); // file node only: imports of it resolve, nothing inside is indexed
  if (file.class === 'config') {
    const sf = parseTs(file.content, file.path);
    handleImports(acc, extractTsImports(sf), resolverFor(ctx), file.path, fileNode.id);
    return acc.result();
  }
  if (file.class === 'test') extractTest(file, ctx, src, acc, fileNode);
  else if (file.path.endsWith('.vue')) extractVue(file, ctx, src, acc, fileNode);
  else extractTs(file, ctx, src, acc, fileNode);
  return acc.result();
};

/** Re-exported for tests and tooling. */
export { componentName };
