// PROMPTS 083: the daemon's in-memory graph, replaceable without ever disturbing a request in flight.
// State is immutable. A request calls `current()` ONCE at its start and uses that object throughout; swapGraph and
// swapWeights build a new state off to the side and replace the reference in one step, so a re-index or a learning
// update that lands mid-request changes nothing for that request.
//   swapGraph    new graph → new CSR + new lexical index (built by the injected function), weights doc kept
//   swapWeights  new weights doc → the CSR is rebuilt only when the learned edge SET changed; otherwise the structure
//                and the lexical index are shared with the previous state
//   weighted()   the CSR with weights for a variant's settings, memoised per state

import type { Graph, WeightsDoc } from '../types.js';
import { csrFromGraph, type Csr } from './csr.js';
import { applyWeights, learnedEdges, settingsKey, type WeightSettings } from './weights.js';

export interface HolderState<L> {
  readonly graph: Graph;
  /** Structure including learned co_changed edges; its own `w` is all zeros: use `holder.weighted(...)`. */
  readonly csr: Csr;
  readonly lexical: L;
  readonly weights: WeightsDoc | null;
  readonly weightsVersion: string | null;
}

export interface HolderOptions<L> {
  /** Builds the lexical index (BM25 + symbol matcher, prompt 085) for a graph. Default: none. */
  buildLexical?: (graph: Graph) => L;
  weights?: WeightsDoc | null;
}

const edgeSetKey = (doc: WeightsDoc | null): string =>
  (doc?.addedEdges ?? [])
    .map((e) => e.key)
    .sort()
    .join('\n');

export class GraphHolder<L = null> {
  private state: HolderState<L>;
  private readonly memo = new WeakMap<HolderState<L>, Map<string, Csr>>();
  private readonly buildLexical: (graph: Graph) => L;

  constructor(graph: Graph, opts: HolderOptions<L> = {}) {
    this.buildLexical = opts.buildLexical ?? ((() => null) as unknown as (graph: Graph) => L);
    this.state = this.make(graph, opts.weights ?? null);
  }

  /** Build a state. `reuseCsr` / `reuseLexical` carry over parts that are still valid for `graph` (same graph, compatible weights). */
  private make(graph: Graph, weights: WeightsDoc | null, reuseCsr?: Csr, reuseLexical?: { value: L }): HolderState<L> {
    return Object.freeze({
      graph,
      csr: reuseCsr ?? csrFromGraph(graph, learnedEdges(weights)),
      lexical: reuseLexical ? reuseLexical.value : this.buildLexical(graph),
      weights,
      weightsVersion: weights?.version ?? null,
    });
  }

  /** The state to use for one whole request. Take it once and keep it. */
  current(): HolderState<L> {
    return this.state;
  }

  swapGraph(graph: Graph): HolderState<L> {
    this.state = this.make(graph, this.state.weights);
    return this.state;
  }

  swapWeights(doc: WeightsDoc | null): HolderState<L> {
    const prev = this.state;
    const sameStructure = edgeSetKey(prev.weights) === edgeSetKey(doc);
    // the graph is unchanged, so the lexical index always carries over; the structure only when no learned edge changed
    this.state = this.make(prev.graph, doc, sameStructure ? prev.csr : undefined, { value: prev.lexical });
    return this.state;
  }

  /** The weighted Csr for `settings` over `state` (default: the current state). Memoised: repeated calls are free. */
  weighted(settings: WeightSettings, state: HolderState<L> = this.state): Csr {
    let perState = this.memo.get(state);
    if (!perState) this.memo.set(state, (perState = new Map()));
    const key = settingsKey(settings);
    let csr = perState.get(key);
    if (!csr) perState.set(key, (csr = applyWeights(state.csr, settings, state.weights)));
    return csr;
  }
}
