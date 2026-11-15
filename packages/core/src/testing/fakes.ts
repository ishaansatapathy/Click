// Test doubles for the frozen Store / Embedder contracts (store/types.ts).
// They let Lane B build and test the pipeline and daemon before Lane A ships MemoryStore and HydraDB.
// FakeStore counts each hybridQuery as one network call (netCounter), so hot-path budget tests stay honest.

import type {
  EdgeRow,
  Embedder,
  GraphStore,
  HybridQuery,
  ImpactOptions,
  NeighbourhoodOptions,
  RemoveIds,
  ScoredId,
  Store,
  UpsertBatch,
} from '../store/types.js';
import type { ChunkRecord, Convention, EdgeKind, GraphEdge, GraphNode, WeightsDoc } from '../types.js';
import { netCounter } from '../util/http.js';

export interface FakeStoreOptions {
  /** Simulated latency of hybridQuery, in ms. */
  latencyMs?: number;
  /** Make hybridQuery reject with this error. */
  failWith?: Error;
  /** Page size for loadAll. */
  pageSize?: number;
}

/** Lowercased identifier-aware tokens: `useOrderStore` → use, order, store. */
export function fakeTokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class FakeStore implements Store {
  readonly name = 'fake';
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();
  readonly chunks = new Map<string, ChunkRecord>();
  private weights: WeightsDoc | null = null;
  private conventions: Convention[] = [];
  /** Number of hybridQuery calls made, for assertions. */
  queries = 0;

  constructor(private readonly opts: FakeStoreOptions = {}) {}

  async upsert(batch: UpsertBatch, _indexVersion: string): Promise<void> {
    for (const n of batch.nodes ?? []) this.nodes.set(n.id, structuredClone(n));
    for (const e of batch.edges ?? []) this.edges.set(e.key, structuredClone(e));
    for (const c of batch.chunks ?? []) this.chunks.set(c.id, structuredClone(c));
  }

  async remove(ids: RemoveIds): Promise<void> {
    for (const id of ids.nodeIds ?? []) this.nodes.delete(id);
    for (const k of ids.edgeKeys ?? []) this.edges.delete(k);
    for (const id of ids.chunkIds ?? []) this.chunks.delete(id);
  }

  async hybridQuery(q: HybridQuery, signal?: AbortSignal): Promise<ScoredId[]> {
    netCounter.call(); // a real store is one network call
    netCounter.attempt();
    this.queries++;
    if (this.opts.latencyMs) await sleep(this.opts.latencyMs, signal);
    if (signal?.aborted) throw abortError(signal);
    if (this.opts.failWith) throw this.opts.failWith;

    const qTokens = new Set(fakeTokens(q.text));
    const docs: { id: string; text: string; vector?: number[] }[] = q.kinds
      ? [...this.nodes.values()]
          .filter((n) => q.kinds!.includes(n.kind))
          .map((n) => ({ id: n.id, text: [n.name, n.path ?? '', n.signature ?? '', n.doc ?? ''].join(' ') }))
      : [...this.chunks.values()].map((c) => ({ id: c.id, text: c.text, vector: c.vector }));

    const scored: ScoredId[] = [];
    for (const d of docs) {
      const dTokens = fakeTokens(d.text);
      const overlap = dTokens.filter((t) => qTokens.has(t)).length;
      const lexical = overlap === 0 ? 0 : overlap / Math.sqrt(dTokens.length);
      const semantic = q.vector && d.vector ? Math.max(0, cosine(q.vector, d.vector)) : 0;
      const score = lexical + semantic;
      if (score > 0) scored.push({ id: d.id, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return scored.slice(0, q.k);
  }

  async *loadAll(): AsyncIterable<UpsertBatch> {
    const size = this.opts.pageSize ?? 100;
    const page = <T>(items: T[]) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
    for (const nodes of page([...this.nodes.values()])) yield { nodes: structuredClone(nodes) };
    for (const edges of page([...this.edges.values()])) yield { edges: structuredClone(edges) };
    for (const chunks of page([...this.chunks.values()])) yield { chunks: structuredClone(chunks) };
  }

  async getWeights(): Promise<WeightsDoc | null> {
    return this.weights ? structuredClone(this.weights) : null;
  }

  async putWeights(doc: WeightsDoc): Promise<void> {
    this.weights = structuredClone(doc);
  }

  async getConventions(): Promise<Convention[]> {
    return structuredClone(this.conventions);
  }

  async putConventions(items: Convention[]): Promise<void> {
    this.conventions = structuredClone(items);
  }
}

/** FNV-1a 32-bit. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic feature-hashing embedder: texts that share identifier tokens get similar vectors,
 * so semantic-seed tests behave sensibly without any API.
 */
export class FakeEmbedder implements Embedder {
  readonly model = 'fake';
  calls = 0;

  constructor(readonly dims = 64) {}

  async embed(texts: string[], _inputType: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array[]> {
    if (signal?.aborted) throw abortError(signal);
    this.calls++;
    return texts.map((t) => {
      const v = new Float32Array(this.dims);
      for (const tok of fakeTokens(t)) {
        const h = fnv1a(tok);
        v[h % this.dims]! += (h & 0x80000000) === 0 ? 1 : -1;
      }
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
      return v;
    });
  }
}

// ---------------------------------------------------------------- FakeGraphStore (contract/1)

export interface FakeGraphStoreOptions {
  latencyMs?: number;
  failWith?: Error;
}

/**
 * In-memory GraphStore with HydraDB's observable semantics: typed directed edges, learned weight `w` (null until set),
 * both-direction neighbourhood, reverse-edge impact paths, PageRank hubs. Each hot-path read counts as one network call.
 */
export class FakeGraphStore implements GraphStore {
  readonly name = 'fake';
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge & { w: number | null }>();
  calls = 0;

  constructor(private readonly opts: FakeGraphStoreOptions = {}) {}

  private async network(signal?: AbortSignal): Promise<void> {
    netCounter.call();
    netCounter.attempt();
    this.calls++;
    if (this.opts.latencyMs) await sleep(this.opts.latencyMs, signal);
    if (signal?.aborted) throw abortError(signal);
    if (this.opts.failWith) throw this.opts.failWith;
  }

  async health(): Promise<{ ok: boolean }> {
    return { ok: !this.opts.failWith };
  }

  async upsertGraph(batch: { nodes?: GraphNode[]; edges?: GraphEdge[] }, _indexVersion: string): Promise<void> {
    for (const n of batch.nodes ?? []) this.nodes.set(n.id, structuredClone(n));
    for (const e of batch.edges ?? []) this.edges.set(e.key, { ...structuredClone(e), w: this.edges.get(e.key)?.w ?? null });
  }

  async removeGraph(ids: { nodeIds?: string[]; edgeKeys?: string[] }): Promise<void> {
    const gone = new Set(ids.nodeIds ?? []);
    for (const id of gone) this.nodes.delete(id);
    for (const k of ids.edgeKeys ?? []) this.edges.delete(k);
    for (const [k, e] of this.edges) if (gone.has(e.from) || gone.has(e.to)) this.edges.delete(k);
  }

  private touching(ids: Set<string>, kinds?: EdgeKind[]): EdgeRow[] {
    const out: EdgeRow[] = [];
    for (const e of this.edges.values()) {
      if (kinds && !kinds.includes(e.kind)) continue;
      if (ids.has(e.from) || ids.has(e.to)) out.push({ from: e.from, to: e.to, kind: e.kind, w: e.w });
    }
    return out;
  }

  async neighbourhood(ids: string[], o: NeighbourhoodOptions, signal?: AbortSignal): Promise<EdgeRow[]> {
    await this.network(signal);
    const seen = new Map<string, EdgeRow>();
    const add = (rows: EdgeRow[]) => rows.forEach((r) => seen.set(`${r.from}|${r.kind}|${r.to}`, r));
    const hop1 = this.touching(new Set(ids), o.kinds);
    add(hop1);
    if (o.hops === 2) {
      const frontier = [...new Set(hop1.flatMap((r) => [r.from, r.to]))].slice(0, o.maxFrontier ?? Infinity);
      add(this.touching(new Set(frontier), o.kinds));
    }
    return [...seen.values()].slice(0, o.maxEdges ?? Infinity);
  }

  async impact(id: string, o: ImpactOptions, signal?: AbortSignal): Promise<{ path: string[]; kinds: EdgeKind[] }[]> {
    await this.network(signal);
    const out: { path: string[]; kinds: EdgeKind[] }[] = [];
    // BFS over incoming edges: a dependent at depth d yields the path dependent → … → id.
    let level: { node: string; path: string[]; kinds: EdgeKind[] }[] = [{ node: id, path: [id], kinds: [] }];
    const visited = new Set([id]);
    for (let d = 0; d < o.maxHops && level.length; d++) {
      const next: typeof level = [];
      for (const cur of level) {
        for (const e of this.edges.values()) {
          if (e.to !== cur.node || visited.has(e.from) || (o.kinds && !o.kinds.includes(e.kind))) continue;
          visited.add(e.from);
          const item = { node: e.from, path: [e.from, ...cur.path], kinds: [e.kind, ...cur.kinds] };
          next.push(item);
          out.push({ path: item.path, kinds: item.kinds });
        }
      }
      level = next;
    }
    return out.slice(0, o.limit ?? Infinity);
  }

  async hubs(k: number, signal?: AbortSignal): Promise<{ id: string; score: number }[]> {
    await this.network(signal);
    const ids = [...this.nodes.keys()].sort();
    if (!ids.length) return [];
    const out = new Map(ids.map((i) => [i, [] as string[]]));
    for (const e of this.edges.values()) out.get(e.from)?.push(e.to);
    let pr = new Map(ids.map((i) => [i, 1 / ids.length]));
    for (let it = 0; it < 30; it++) {
      const next = new Map(ids.map((i) => [i, 0.15 / ids.length]));
      for (const i of ids) {
        const targets = out.get(i)!.filter((t) => next.has(t));
        const share = (0.85 * pr.get(i)!) / (targets.length || ids.length);
        for (const t of targets.length ? targets : ids) next.set(t, next.get(t)! + share);
      }
      pr = next;
    }
    return ids.map((id) => ({ id, score: pr.get(id)! })).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, k);
  }

  async setEdgeWeights(updates: { key: string; w: number }[]): Promise<void> {
    for (const u of updates) {
      const e = this.edges.get(u.key);
      if (e) e.w = u.w;
    }
  }

  async *loadAll(): AsyncIterable<{ nodes?: GraphNode[]; edges?: GraphEdge[] }> {
    yield { nodes: [...this.nodes.values()].map((n) => structuredClone(n)) };
    yield { edges: [...this.edges.values()].map(({ w: _w, ...e }) => structuredClone(e)) };
  }
}
