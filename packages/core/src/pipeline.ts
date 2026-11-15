// PROMPTS 094: getContext(task, cfg, deps), the whole product in one function.
//   seeds (symbol + BM25 local, semantic in parallel)  →  weighted RRF  →  graph (HydraDB 2-hop neighbourhood within
//   graphTimeoutMs, else the local replica)  →  personalised PPR  →  candidates  →  prune chain  →  pack.
// Everything has a deadline and a fallback; a slow or broken part degrades the answer and says so in `degraded`, it never
// blocks it. The graph state is taken once at the start, so a re-index or a learning update landing mid-request is invisible.
// Network calls on the hot path: one for the query embedding (semantic) and one for the neighbourhood (graph).

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { configHash, type VariantConfig } from './config.js';
import type { ContextRecord, PipelineDeps } from './contracts.js';
import { BodyReader } from './graph/bodies.js';
import { buildCsr, type Csr, type CsrEdge } from './graph/csr.js';
import { GraphHolder, type HolderState } from './graph/holder.js';
import { pprPush } from './graph/ppr.js';
import { SnapshotStore } from './graph/snapshot.js';
import { applyWeights, weightSettings } from './graph/weights.js';
import { chunkResolver, fuseSeeds } from './retrieve/fuse.js';
import { buildLexicalIndex, type LexicalIndex } from './retrieve/lexical.js';
import { buildCandidateGraph, chunkCandidates, pprCandidates, seedCandidates, type CandidateGraph } from './retrieve/candidates.js';
import { semanticSeeds } from './retrieve/semantic.js';
import { buildSymbolIndex, type SymbolIndex } from './retrieve/symbols.js';
import { pack, type BodySource, type ChunkMeta, type Neighbour } from './pack/pack.js';
import { conventionLines, SkeletonProvider } from './pack/prefix.js';
import { runPruneChain, type PrunerRegistry } from './prune/chain.js';
import type { ScoredId } from './store/types.js';
import type { Candidate, Graph, PackedContext, Seed, Task, WeightsDoc } from './types.js';
import { Deadline, DeadlineError, Timings, withDeadline } from './util/deadline.js';
import { sha1 } from './util/hash.js';
import { clickDir } from './util/paths.js';

export interface Lexical {
  bm25: LexicalIndex;
  symbols: SymbolIndex;
}
export const buildLexical = (graph: Graph): Lexical => ({ bm25: buildLexicalIndex(graph), symbols: buildSymbolIndex(graph) });

/** What a long-lived caller (the daemon, the bench) can supply on top of the frozen PipelineDeps. All optional. */
export interface PipelineExtras {
  /** The in-memory graph. Absent: the snapshot under `<root>/.click/graph` is loaded (and cached per root + version). */
  holder?: GraphHolder<Lexical>;
  bodies?: BodySource;
  pruners?: PrunerRegistry;
  prefix?: SkeletonProvider;
  /** Node ids already sent in a session (for `pack.sessionDedupe`). */
  sent?: (sessionId: string | undefined) => ReadonlySet<string> | undefined;
  /** Hard cap on the packed text, in characters. */
  maxChars?: number;
  /** Who is asking, recorded in the ContextRecord ('hook' | 'mcp' | 'api' | 'bench'…). */
  source?: string;
  newId?: () => string;
}
export type PipelineInput = PipelineDeps & PipelineExtras;

const SEED_LIST_K = 30;
const OPEN_FILE_SHARE = 0.15;

// ---------------------------------------------------------------- per-process caches

interface Prepared {
  cg: CandidateGraph;
  chunks: ReadonlyMap<string, ChunkMeta>;
  resolve: (id: string) => string;
}
const prepared = new WeakMap<object, Prepared>();
function prepare(state: HolderState<Lexical>): Prepared {
  let p = prepared.get(state);
  if (!p) {
    p = {
      cg: buildCandidateGraph(state.graph),
      chunks: new Map(state.graph.chunks.map((c) => [c.id, c])),
      resolve: chunkResolver(state.graph),
    };
    prepared.set(state, p);
  }
  return p;
}

const defaultHolders = new Map<string, { version: string; holder: GraphHolder<Lexical> }>();
const bodyReaders = new Map<string, BodyReader>();
const skeletons = new WeakMap<object, SkeletonProvider>();

async function holderFor(deps: PipelineInput, wantLearned: boolean): Promise<GraphHolder<Lexical> | null> {
  if (deps.holder) return deps.holder;
  const snaps = new SnapshotStore(join(clickDir(deps.root), 'graph'));
  const current = await snaps.currentVersion().catch(() => null);
  const hit = defaultHolders.get(deps.root);
  if (hit && current !== null && hit.version === current) return hit.holder;
  const loaded = await snaps.load();
  if (!loaded.ok) return null;
  const holder = new GraphHolder<Lexical>(loaded.graph, { buildLexical });
  if (wantLearned) {
    const w = await deps.store.getWeights().catch(() => null);
    if (w) holder.swapWeights(w);
  }
  defaultHolders.set(deps.root, { version: loaded.graph.version, holder });
  return holder;
}

function bodiesFor(deps: PipelineInput): BodySource {
  if (deps.bodies) return deps.bodies;
  let r = bodyReaders.get(deps.root);
  if (!r) bodyReaders.set(deps.root, (r = new BodyReader(deps.root)));
  return r;
}

// ---------------------------------------------------------------- helpers

const isTimeout = (e: unknown): boolean => e instanceof DeadlineError || (e instanceof Error && (e.name === 'DeadlineError' || e.name === 'AbortError'));

function csrFromRows(
  rows: readonly { from: string; to: string; kind: CsrEdge['kind']; w: number | null }[],
  seedIds: readonly string[],
  state: HolderState<Lexical>,
  cfg: VariantConfig,
): Csr {
  const ids = new Set(seedIds);
  const edges: CsrEdge[] = [];
  const multipliers: Record<string, number> = {};
  for (const r of rows) {
    ids.add(r.from);
    ids.add(r.to);
    const key = `${r.from}|${r.kind}|${r.to}`;
    edges.push({ key, from: r.from, to: r.to, kind: r.kind });
    if (r.w !== null) multipliers[key] = r.w;
  }
  const csr = buildCsr([...ids].sort(), edges);
  const doc: WeightsDoc = {
    v: 1, version: 'hydra', derivedFrom: null, events: 0,
    params: state.weights?.params ?? { alpha: 0.2, beta: 0.1, min: 0.1, max: 5 },
    multipliers,
    addedEdges: state.weights?.addedEdges ?? [],
  };
  return applyWeights(csr, weightSettings(cfg.expand), doc);
}

const hasArcs = (csr: Csr, id: string): boolean => {
  const i = csr.index.get(id);
  return i !== undefined && csr.offsets[i + 1]! > csr.offsets[i]!;
};

function neighbourFn(csr: Csr): (nodeId: string) => Neighbour[] {
  return (nodeId) => {
    const u = csr.index.get(nodeId);
    if (u === undefined) return [];
    const out: Neighbour[] = [];
    for (let a = csr.offsets[u]!; a < csr.offsets[u + 1]!; a++) if (csr.w[a]! > 0) out.push({ nodeId: csr.ids[csr.targets[a]!]!, weight: csr.w[a]! });
    return out;
  };
}

// ---------------------------------------------------------------- getContext

export async function getContext(task: Task, cfg: VariantConfig, deps: PipelineInput): Promise<{ packed: PackedContext; record: ContextRecord }> {
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = new Deadline(cfg.deadlineMs);
  const timings = new Timings();
  const degraded: string[] = [];
  const flag = (d: string): void => {
    if (!degraded.includes(d)) degraded.push(d);
  };
  const budget = task.budgetTokens > 0 ? task.budgetTokens : cfg.budgetTokens;
  const finish = (partial: Omit<PackedContext, 'contextId' | 'variant' | 'configHash' | 'budget' | 'timings' | 'degraded'> & { candidates?: Candidate[]; repoCommit?: string | null }): { packed: PackedContext; record: ContextRecord } => {
    const ms = now() - started;
    const contextId = deps.newId?.() ?? `ctx_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const t = { ...timings.toJSON(), total: Math.round(ms * 10) / 10 };
    const packed: PackedContext = {
      contextId, text: partial.text, tokens: partial.tokens, budget, items: partial.items, seeds: partial.seeds,
      variant: cfg.id, configHash: configHash(cfg), pruner: partial.pruner, graphVersion: partial.graphVersion,
      weightsVersion: partial.weightsVersion, timings: t, degraded: [...degraded],
    };
    const via = new Map((partial.candidates ?? []).map((c) => [c.nodeId, c.via]));
    const record: ContextRecord = {
      v: 1, contextId, ts: new Date(now()).toISOString(), ...(task.sessionId ? { sessionId: task.sessionId } : {}), source: deps.source ?? 'api',
      variant: cfg.id, configHash: packed.configHash, graphVersion: partial.graphVersion, weightsVersion: partial.weightsVersion,
      taskText: task.text, taskHash: sha1(task.text), repoCommit: partial.repoCommit ?? null,
      seeds: partial.seeds.map((s) => ({ nodeId: s.nodeId, score: s.score })),
      items: partial.items.map((i) => ({ nodeId: i.nodeId, mode: i.mode })),
      attribution: Object.fromEntries(partial.items.flatMap((i) => (via.get(i.nodeId)?.length ? [[i.nodeId, via.get(i.nodeId)!]] : []))),
      tokens: partial.tokens, ms: Math.round(ms), degraded: [...degraded],
    };
    return { packed, record };
  };

  // the graph state for this whole request
  const holder = await timings.time('load', () => holderFor(deps, cfg.expand.useLearned));
  if (!holder) {
    flag('warming');
    return finish({ text: '', tokens: 0, items: [], seeds: [], pruner: 'none', graphVersion: '', weightsVersion: null });
  }
  const state = holder.current();
  const { cg, chunks, resolve } = prepare(state);
  const text = task.text;
  const wantSemantic = cfg.seeds.sources.includes('semantic') && cfg.semantic.mode === 'local';

  // ---- seeds: lexical in this tick, semantic running alongside
  let semanticHits: ScoredId[] = [];
  const semanticDone = (async () => {
    if (!wantSemantic) return;
    if (!deps.embedder) return flag('semantic-off');
    const t0 = performance.now();
    const sub = deadline.child(cfg.semantic.timeoutMs);
    try {
      const hits = await withDeadline(
        semanticSeeds(text, { mode: 'local', k: cfg.semantic.k, deadline: sub }, { store: deps.store, embedder: deps.embedder }),
        sub.remaining(),
        () => null,
      );
      if (hits === null) flag('semantic-timeout');
      else semanticHits = hits;
    } catch (e) {
      flag(isTimeout(e) ? 'semantic-timeout' : 'semantic-error');
    } finally {
      sub.dispose();
      timings.mark('semantic', performance.now() - t0);
    }
  })();

  const lists = await timings.time('lexical', () => ({
    symbol: cfg.seeds.sources.includes('symbol') ? state.lexical.symbols.match(text, SEED_LIST_K) : [],
    bm25: cfg.seeds.sources.includes('bm25') ? state.lexical.bm25.search(text, SEED_LIST_K) : [],
  }));
  await semanticDone;

  const known = (id: string): boolean => cg.nodes.has(resolve(id));
  const semantic = semanticHits.filter((h) => known(h.id));
  let seeds: Seed[] = fuseSeeds({ ...lists, semantic }, { sources: cfg.seeds.sources, weights: cfg.seeds.weights, count: cfg.seeds.count, rrfK: cfg.seeds.rrfK, semanticReserve: cfg.seeds.reserve }, resolve);
  seeds = withOpenFiles(seeds, task.openFiles, cg);

  // ---- candidates
  let candidates: Candidate[];
  let neighbours: ((id: string) => Neighbour[]) | undefined;
  if (cfg.units === 'chunk') {
    candidates = chunkCandidates(semantic.filter((h) => chunks.has(h.id)), text, cfg.candidates);
  } else if (cfg.expand.kind === 'none') {
    candidates = seedCandidates(cg, seeds, text, cfg.candidates);
  } else {
    const graphT0 = performance.now();
    const settings = weightSettings(cfg.expand);
    const seedIds = seeds.map((s) => s.nodeId);
    let csr: Csr | null = null;
    if (seedIds.length > 0 && cfg.expand.graphSource === 'hydra') {
      if (deps.graph) {
        const sub = deadline.child(cfg.expand.graphTimeoutMs);
        try {
          const rows = await withDeadline(
            deps.graph.neighbourhood(seedIds, { hops: cfg.expand.hops, maxFrontier: cfg.expand.maxFrontier }, sub.signal),
            sub.remaining(),
            () => null,
          );
          // an empty answer for seeds that do have neighbours locally means HydraDB is not in sync: use the replica
          if (rows && !(rows.length === 0 && seedIds.some((id) => hasArcs(state.csr, id)))) csr = csrFromRows(rows, seedIds, state, cfg);
        } catch {
          // fall back below
        } finally {
          sub.dispose();
        }
      }
      if (!csr) flag('graph-replica');
    }
    timings.mark('graph', performance.now() - graphT0);
    csr ??= holder.weighted(settings, state);
    const pprT0 = performance.now();
    const ppr = pprPush(csr, seeds, { alpha: cfg.expand.alpha, epsilon: cfg.expand.epsilon, maxPushes: cfg.expand.maxPushes });
    candidates = pprCandidates(cg, csr, ppr, seeds, text, cfg.candidates);
    timings.mark('ppr', performance.now() - pprT0);
    if (cfg.pack.neighbourSignatures) neighbours = neighbourFn(csr);
  }

  // ---- prune (a chain of one 'none' is free)
  const pruned = await timings.time('prune', () => runPruneChain(task, candidates, cg.nodes, deps.pruners ?? {}, cfg.prune, deadline));
  if (pruned.fallbacks.length > 0) flag('prune-fallback');
  const pruner = pruned.fallbacks.length > 0 ? pruned.fallbacks[pruned.fallbacks.length - 1]! : pruned.used;

  // ---- prefix
  let prefix: { conventions: string[]; skeleton: string[] } | undefined;
  if (cfg.pack.prefix) {
    const provider = deps.prefix ?? providerFor(deps);
    const settings = weightSettings(cfg.expand);
    const got = await timings.time('prefix', async () => {
      try {
        const [conventions, skeleton] = await Promise.all([
          deps.store.getConventions().then(conventionLines),
          withDeadline(provider.get({ version: state.graph.version, nodes: cg.nodes, csr: () => holder.weighted(settings, state) }), deadline.remaining(), () => null),
        ]);
        return skeleton ? { conventions, skeleton: skeleton.lines } : null;
      } catch {
        return null;
      }
    });
    if (got) prefix = got;
    else flag('prefix-timeout');
  }

  // ---- pack
  const sent = cfg.pack.sessionDedupe ? deps.sent?.(task.sessionId) : undefined;
  const packed = await timings.time('pack', () =>
    pack(pruned.candidates, {
      budget,
      pack: cfg.pack,
      header: { graph: state.graph.version, ms: now() - started, degraded },
      nodes: cg.nodes,
      chunks,
      bodies: bodiesFor(deps),
      ...(deps.maxChars ? { maxChars: deps.maxChars } : {}),
      ...(sent ? { sent } : {}),
      ...(neighbours ? { neighbours } : {}),
      ...(prefix ? { prefix } : {}),
    }),
  );
  for (const d of packed.degraded) flag(d);
  deadline.dispose();

  return finish({
    text: packed.text, tokens: packed.tokens, items: packed.items, seeds, pruner,
    graphVersion: state.graph.version, weightsVersion: state.weightsVersion,
    candidates: pruned.candidates, repoCommit: state.graph.repoCommit,
  });
}

function providerFor(deps: PipelineInput): SkeletonProvider {
  const key = (deps.graph ?? deps.store) as object;
  let p = skeletons.get(key);
  if (!p) skeletons.set(key, (p = new SkeletonProvider({ graphStore: deps.graph ?? null })));
  return p;
}

/** Files the user has open are strong hints: they take a fixed share of the restart mass, labelled 'open-file'. */
function withOpenFiles(seeds: Seed[], openFiles: readonly string[] | undefined, cg: CandidateGraph): Seed[] {
  const ids = [...new Set((openFiles ?? []).map((p) => `file:${p}`))].filter((id) => cg.nodes.has(id)).sort();
  if (ids.length === 0) return seeds;
  const scaled = new Map<string, Seed>(seeds.map((s) => [s.nodeId, { ...s, score: s.score * (1 - OPEN_FILE_SHARE) }]));
  for (const id of ids) {
    const prev = scaled.get(id);
    const add = OPEN_FILE_SHARE / ids.length;
    scaled.set(id, prev ? { ...prev, score: prev.score + add, sources: [...prev.sources, 'open-file'] } : { nodeId: id, score: add, sources: ['open-file'] });
  }
  return [...scaled.values()].sort((a, b) => b.score - a.score || (a.nodeId < b.nodeId ? -1 : 1));
}
