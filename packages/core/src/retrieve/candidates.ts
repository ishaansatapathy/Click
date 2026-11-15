// PROMPTS 090 / SPEC §6.6: turn scores (PPR, or fused seeds, or chunk hits) into the list of things we could pack.
//   units    = symbols, components, composables, stores, types. A route maps to the component it renders; a file maps to its
//              highest-scoring contained unit, or stays a whole-file unit when it holds none.
//   exclude  = test and generated files, unless the task text mentions test / spec / vitest.
//   output   = top N Candidates, each with `via` (edge keys seed → node) and human-readable `reasons`.
// `expand: none` paths: V2 packs the fused seeds themselves (seedCandidates), V1 packs semantic chunk hits (chunkCandidates).
// For V2 and V1 there is no PPR, so `pprScore` carries the seed / hit score: it is only used to order and display.

import { classifyFile } from '../indexer/discover.js';
import type { Csr } from '../graph/csr.js';
import { attributionPath } from '../graph/path.js';
import type { PprResult } from '../graph/ppr.js';
import type { ScoredId } from '../store/types.js';
import type { Candidate, GraphEdge, GraphNode, NodeKind, Seed } from '../types.js';

const UNIT_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['function', 'component', 'composable', 'store', 'type', 'test']); // 'test' units only survive when the task asks for tests (see excluded)
const MAX_ROUTE_HOPS = 3; // route → file → unit, with a little slack

/** Does the task ask about tests? Then test files are allowed back in. */
export const mentionsTests = (text: string): boolean => /\b(tests?|testing|specs?|vitest)\b/i.test(text);

export interface CandidateGraph {
  readonly nodes: ReadonlyMap<string, GraphNode>;
  /** Contained units of each file/container, in source order. */
  readonly children: ReadonlyMap<string, readonly GraphNode[]>;
  readonly routeTargets: ReadonlyMap<string, readonly string[]>;
}

export function buildCandidateGraph(graph: { nodes: readonly GraphNode[]; edges: readonly Pick<GraphEdge, 'from' | 'to' | 'kind'>[] }): CandidateGraph {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const children = new Map<string, GraphNode[]>();
  const routeTargets = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.kind === 'contains') {
      const child = nodes.get(e.to);
      if (child && UNIT_KINDS.has(child.kind)) (children.get(e.from) ?? children.set(e.from, []).get(e.from)!).push(child);
    } else if (e.kind === 'routes_to' && nodes.has(e.to)) {
      (routeTargets.get(e.from) ?? routeTargets.set(e.from, []).get(e.from)!).push(e.to);
    }
  }
  for (const list of children.values()) list.sort((a, b) => (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || cmp(a.id, b.id));
  return { nodes, children, routeTargets };
}

/** A score arriving at some node, with how we got there. */
interface Contribution {
  nodeId: string;
  score: number;
  via: string[];
  reasons: string[];
}

interface Resolved {
  unitId: string;
  note: string | null; // "from route X" / "from file Y" when the score was moved onto a contained unit
}

function excluded(node: GraphNode, allowTests: boolean): boolean {
  if (allowTests) return false;
  if (node.kind === 'test') return true;
  if (!node.path) return false;
  const cls = classifyFile(node.path);
  return cls === 'test' || cls === 'generated';
}

/** The unit(s) a scored node stands for. */
function resolveUnits(cg: CandidateGraph, id: string, direct: ReadonlyMap<string, number>, depth = 0): Resolved[] {
  const node = cg.nodes.get(id);
  if (!node || depth > MAX_ROUTE_HOPS) return [];
  if (UNIT_KINDS.has(node.kind)) return [{ unitId: id, note: null }];
  if (node.kind === 'route') {
    return (cg.routeTargets.get(id) ?? []).flatMap((t) => resolveUnits(cg, t, direct, depth + 1).map((r) => ({ unitId: r.unitId, note: `from route ${node.name}` })));
  }
  if (node.kind === 'file') {
    const kids = cg.children.get(id) ?? [];
    if (kids.length === 0) return [{ unitId: id, note: null }]; // no symbols: the whole file is the unit
    let best = kids[0]!;
    for (const k of kids) if ((direct.get(k.id) ?? 0) > (direct.get(best.id) ?? 0)) best = k; // ties keep source order
    return [{ unitId: best.id, note: `from file ${node.path ?? node.name}` }];
  }
  return []; // chunk, convention, test (handled by exclusion)
}

function assemble(cg: CandidateGraph, contribs: readonly Contribution[], taskText: string, limit: number): Candidate[] {
  const allowTests = mentionsTests(taskText);
  const direct = new Map<string, number>();
  for (const c of contribs) if (UNIT_KINDS.has(cg.nodes.get(c.nodeId)?.kind as NodeKind)) direct.set(c.nodeId, Math.max(direct.get(c.nodeId) ?? 0, c.score));

  const best = new Map<string, { score: number; contrib: Contribution; note: string | null }>();
  for (const c of contribs) {
    const origin = cg.nodes.get(c.nodeId);
    if (!origin || excluded(origin, allowTests)) continue;
    for (const { unitId, note } of resolveUnits(cg, c.nodeId, direct)) {
      const unit = cg.nodes.get(unitId);
      if (!unit || excluded(unit, allowTests)) continue;
      const cur = best.get(unitId);
      // the strongest contribution wins; equal scores prefer the one that is the unit itself, then the smaller id
      if (!cur || c.score > cur.score || (c.score === cur.score && (note === null && cur.note !== null || cmp(c.nodeId, cur.contrib.nodeId) < 0))) {
        best.set(unitId, { score: c.score, contrib: c, note });
      }
    }
  }

  return [...best]
    .map(([nodeId, b]): Candidate => ({
      nodeId,
      score: b.score,
      pprScore: b.score,
      via: b.contrib.via,
      reasons: b.note ? [...b.contrib.reasons, b.note] : b.contrib.reasons,
    }))
    .sort((a, b) => b.score - a.score || cmp(a.nodeId, b.nodeId))
    .slice(0, Math.max(0, limit));
}

/** V3 / V3r / V5: candidates from a PPR result over `csr`. `seeds` supply the "why did we start here" reasons. */
export function pprCandidates(
  cg: CandidateGraph,
  csr: Csr,
  ppr: Pick<PprResult, 'scores' | 'via' | 'seedIdx'>,
  seeds: readonly Seed[],
  taskText: string,
  limit: number,
): Candidate[] {
  const seedSources = new Map(seeds.map((s) => [s.nodeId, s.sources]));
  const contribs: Contribution[] = [];
  for (const [idx, score] of ppr.scores) {
    const id = csr.ids[idx]!;
    const path = attributionPath(csr, ppr, idx);
    contribs.push({ nodeId: id, score, via: path.edgeKeys, reasons: [reasonFor(cg, id, seedSources, path.edgeKeys, path.nodeIds)] });
  }
  return assemble(cg, contribs, taskText, limit);
}

/** V2 (expand: none): the fused seeds are the candidates. */
export function seedCandidates(cg: CandidateGraph, seeds: readonly Seed[], taskText: string, limit: number): Candidate[] {
  const sources = new Map(seeds.map((s) => [s.nodeId, s.sources]));
  return assemble(
    cg,
    seeds.map((s) => ({ nodeId: s.nodeId, score: s.score, via: [], reasons: [reasonFor(cg, s.nodeId, sources, [], [])] })),
    taskText,
    limit,
  );
}

/** V1 (units: chunk): semantic chunk hits, best first. The candidate's nodeId is the chunk id. */
export function chunkCandidates(hits: readonly ScoredId[], taskText: string, limit: number): Candidate[] {
  const allowTests = mentionsTests(taskText);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const h of [...hits].sort((a, b) => b.score - a.score || cmp(a.id, b.id))) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    const path = chunkPath(h.id);
    if (!allowTests && path && ['test', 'generated'].includes(classifyFile(path))) continue;
    out.push({ nodeId: h.id, score: h.score, pprScore: h.score, via: [], reasons: ['seed: semantic chunk match'] });
  }
  return out.slice(0, Math.max(0, limit));
}

/** `chunk:<path>#<symbol|_template|_file>#<n>` → path. */
const chunkPath = (id: string): string | null => (id.startsWith('chunk:') ? id.slice(6).split('#')[0] || null : null);

function reasonFor(cg: CandidateGraph, id: string, seedSources: ReadonlyMap<string, readonly string[]>, edgeKeys: readonly string[], pathNodes: readonly string[]): string {
  const src = seedSources.get(id);
  if (src) return `seed: ${src.map((s) => (s === 'open-file' ? 'open file' : `${s} match`)).join(' + ')}`;
  const last = edgeKeys.at(-1);
  if (last) {
    const kind = last.split('|')[1] ?? 'edge';
    const prev = cg.nodes.get(pathNodes.at(-2) ?? '')?.name ?? pathNodes.at(-2) ?? 'a seed';
    return `via ${kind} from ${prev}`;
  }
  return 'graph expansion';
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
