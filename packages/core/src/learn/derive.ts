// PROMPTS 154 / SPEC §15: how Click learns. A pure, deterministic function from the logs to a WeightsDoc; nothing is stored here,
// so the weights can always be rebuilt (or rolled back) from the append-only logs.
//
// For every outcome o, in (ts, id) order:
//   P  did the work pass?  o.check.passed, else the matching check_result, else null
//   C  the nodes of the contexts that were sent;  att  the edge path that brought each there;  S  the seeds;  E  files edited;  D  symbols changed
//   used(n)     the agent edited n's file or changed n's name
//   related(n)  used(n), or n's file is one `imports` hop from an edited file
// Rules (each edge changes at most once per rule per outcome; every multiplier is clamped to [min, max] after each change):
//   1. P true: every edge on the path to a USED node is reinforced        × (1 + α)
//   2. P true: the LAST edge on the path to an unrelated, non-seed node decays × (1 − β)
//   3. P true: an edited file that was not in the context gets a learned co_changed edge from the best seed's file (new: 1.0, again: × (1 + α))
//   4. P false or unknown: nothing changes
// An edge that helped is trusted more, one that only brought noise less, a miss becomes a shortcut for next time.

import type { ContextRecord, LogEvent, OutcomeEvent } from '../contracts.js';
import type { GraphEdge, GraphNode, LearnParams, WeightsDoc } from '../types.js';
import { hashOf } from '../util/hash.js';

export const DEFAULT_PARAMS: LearnParams = { alpha: 0.2, beta: 0.1, min: 0.1, max: 5 };

export interface GraphView {
  nodes: readonly GraphNode[];
  edges: readonly Pick<GraphEdge, 'key' | 'from' | 'to' | 'kind'>[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const round = (x: number): number => Math.round(x * 1e6) / 1e6; // readable files, and no float noise in the version hash

export function deriveWeights(events: readonly LogEvent[], contexts: readonly ContextRecord[], graph: GraphView, params: LearnParams = DEFAULT_PARAMS): WeightsDoc {
  const { alpha, beta, min, max } = params;
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const fileIdByPath = new Map<string, string>();
  for (const n of graph.nodes) if (n.kind === 'file' && n.path) fileIdByPath.set(n.path, n.id);
  const importPairs = new Set<string>(); // "pathA\0pathB", both directions
  const graphCoChanged = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind === 'co_changed') graphCoChanged.add(e.key);
    if (e.kind !== 'imports') continue;
    const a = nodes.get(e.from)?.path;
    const b = nodes.get(e.to)?.path;
    if (a && b && a !== b) {
      importPairs.add(`${a}\0${b}`);
      importPairs.add(`${b}\0${a}`);
    }
  }
  const ctxById = new Map(contexts.map((c) => [c.contextId, c]));

  const outcomes = events.filter((e): e is OutcomeEvent => e.type === 'outcome').sort((a, b) => cmp(a.ts, b.ts) || cmp(a.id, b.id));
  const checks = new Map<string, boolean>();
  for (const c of events.filter((e) => e.type === 'check_result').sort((a, b) => cmp(a.ts, b.ts) || cmp(a.id, b.id))) {
    if (c.type === 'check_result') checks.set(c.outcomeId, c.passed); // the latest verdict for an outcome wins
  }

  const mult = new Map<string, number>();
  const added = new Map<string, GraphEdge>();
  const clamp = (x: number): number => Math.min(max, Math.max(min, x));
  const bump = (key: string, factor: number): void => void mult.set(key, round(clamp((mult.get(key) ?? 1) * factor)));

  for (const o of outcomes) {
    const P: boolean | null = o.check.passed ?? checks.get(o.id) ?? null;
    if (P !== true) continue; // rule 4: a failure or an unknown result changes nothing

    const K = o.contextIds.flatMap((id) => (ctxById.has(id) ? [ctxById.get(id)!] : []));
    if (K.length === 0) continue;
    const C = new Set<string>();
    const att = new Map<string, string[]>(); // first context wins
    const seeds = new Map<string, number>();
    for (const k of K) {
      for (const it of k.items) C.add(it.nodeId);
      for (const id of Object.keys(k.attribution).sort(cmp)) if (!att.has(id)) att.set(id, k.attribution[id]!);
      for (const s of k.seeds) seeds.set(s.nodeId, Math.max(seeds.get(s.nodeId) ?? 0, s.score));
    }
    const E = new Set(o.filesEdited);
    const D = new Set(o.diffSymbols);
    const sortedC = [...C].sort(cmp);
    const pathOf = (id: string): string | null => nodes.get(id)?.path ?? null;
    const used = (id: string): boolean => {
      const n = nodes.get(id);
      return !!n && ((n.path !== null && E.has(n.path)) || D.has(n.name));
    };
    const related = (id: string): boolean => {
      if (used(id)) return true;
      const p = pathOf(id);
      if (!p) return false;
      for (const f of E) if (importPairs.has(`${p}\0${f}`)) return true;
      return false;
    };

    // rule 1: reinforce the whole path to every node that was used
    const r1 = new Set<string>();
    for (const id of sortedC) {
      if (!nodes.has(id) || !used(id)) continue;
      for (const key of att.get(id) ?? []) {
        if (r1.has(key)) continue;
        r1.add(key);
        bump(key, 1 + alpha);
      }
    }

    // rule 2: the last edge to an unrelated node that was not a seed decays
    const r2 = new Set<string>();
    for (const id of sortedC) {
      if (!nodes.has(id) || seeds.has(id) || related(id)) continue;
      const last = att.get(id)?.at(-1);
      if (last && !r2.has(last)) {
        r2.add(last);
        bump(last, 1 - beta);
      }
    }

    // rule 3: an edited file the context missed becomes a shortcut from the best seed
    const coveredPaths = new Set(sortedC.flatMap((id) => (pathOf(id) ? [pathOf(id)!] : [])));
    const bestSeed = [...seeds].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]?.[0];
    const from = bestSeed ? (nodes.get(bestSeed)?.kind === 'file' ? bestSeed : fileIdByPath.get(pathOf(bestSeed) ?? '')) : undefined;
    const r3 = new Set<string>();
    if (from) {
      for (const f of [...E].sort(cmp)) {
        if (coveredPaths.has(f)) continue;
        const to = fileIdByPath.get(f);
        if (!to || to === from) continue;
        const key = `${from}|co_changed|${to}`;
        const reverse = `${to}|co_changed|${from}`;
        const existing = added.has(key) || graphCoChanged.has(key) ? key : added.has(reverse) || graphCoChanged.has(reverse) ? reverse : null; // one undirected pair
        if (existing === null) {
          added.set(key, { key, from, to, kind: 'co_changed', meta: { source: 'learned', support: 1 } });
          mult.set(key, round(clamp(1)));
        } else if (!r3.has(existing)) {
          const a = added.get(existing);
          if (a?.meta) a.meta.support = (a.meta.support ?? 1) + 1;
          bump(existing, 1 + alpha);
        }
        r3.add(existing ?? key);
      }
    }
  }

  const multipliers = Object.fromEntries([...mult].sort((a, b) => cmp(a[0], b[0])));
  const addedEdges = [...added.values()].sort((a, b) => cmp(a.key, b.key));
  return {
    v: 1,
    version: hashOf({ params, multipliers, addedEdges }),
    derivedFrom: outcomes.length ? outcomes[outcomes.length - 1]!.id : null,
    events: outcomes.length,
    params,
    multipliers,
    addedEdges,
  };
}
