// Graph helpers for the explorer: a small deterministic force layout and the "what breaks if I change X" walk.
// Both are pure functions so they are tested without a browser.

import type { GraphData } from './data/types.js';

export interface Point {
  x: number;
  y: number;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fruchterman–Reingold with a cooling schedule; the same input always gives the same picture. */
export function forceLayout(ids: readonly string[], edges: readonly { from: string; to: string }[], opts: { width: number; height: number; iterations?: number; seed?: number }): Map<string, Point> {
  const { width, height } = opts;
  const iterations = opts.iterations ?? 260;
  const rnd = mulberry32(opts.seed ?? 7);
  const n = ids.length;
  const index = new Map(ids.map((id, i) => [id, i]));
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * Math.min(width, height) * 0.42;
    px[i] = width / 2 + Math.cos(a) * r;
    py[i] = height / 2 + Math.sin(a) * r;
  }
  const links: [number, number][] = [];
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) links.push([a, b]);
  }
  const k = Math.sqrt((width * height) / Math.max(1, n)) * 0.75;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    const temp = (Math.min(width, height) / 8) * (1 - it / iterations) + 0.5;
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = px[i]! - px[j]!;
        let ey = py[i]! - py[j]!;
        let d2 = ex * ex + ey * ey;
        if (d2 < 0.01) {
          ex = rnd() - 0.5;
          ey = rnd() - 0.5;
          d2 = ex * ex + ey * ey + 0.01;
        }
        const f = (k * k) / d2; // repulsion k^2/d, applied along the unit vector (divide by d once more)
        dx[i]! += ex * f;
        dy[i]! += ey * f;
        dx[j]! -= ex * f;
        dy[j]! -= ey * f;
      }
    }
    for (const [a, b] of links) {
      const ex = px[a]! - px[b]!;
      const ey = py[a]! - py[b]!;
      const d = Math.sqrt(ex * ex + ey * ey) || 0.01;
      const f = d / k; // attraction d^2/k along the unit vector
      dx[a]! -= ex * f;
      dy[a]! -= ey * f;
      dx[b]! += ex * f;
      dy[b]! += ey * f;
    }
    for (let i = 0; i < n; i++) {
      // gentle pull to the centre keeps disconnected pieces on the canvas
      dx[i]! += (width / 2 - px[i]!) * 0.02;
      dy[i]! += (height / 2 - py[i]!) * 0.02;
      const d = Math.sqrt(dx[i]! * dx[i]! + dy[i]! * dy[i]!) || 0.01;
      const step = Math.min(d, temp);
      px[i]! += (dx[i]! / d) * step;
      py[i]! += (dy[i]! / d) * step;
      px[i] = Math.max(24, Math.min(width - 24, px[i]!));
      py[i] = Math.max(24, Math.min(height - 24, py[i]!));
    }
  }
  return new Map(ids.map((id, i) => [id, { x: px[i]!, y: py[i]! }]));
}

/** Edge kinds that mean "from depends on to": changing `to` can break `from`. */
export const DEPENDENCY_KINDS = new Set(['imports', 'uses_component', 'uses_store', 'uses_composable', 'calls', 'routes_to', 'passes_prop', 'has_type', 'emits_to']);

export interface Dependent {
  id: string;
  hops: number;
  /** The edge chain from the changed file out to this dependent, e.g. ["imports", "uses_store"]. */
  chain: string[];
}

/** Everything that depends on `start`, up to `maxHops` away, nearest first, with the way to it. Cycle-safe. */
export function dependents(graph: Pick<GraphData, 'edges'>, start: string, maxHops = 3): Dependent[] {
  const incoming = new Map<string, { from: string; kind: string }[]>();
  for (const e of graph.edges) {
    if (!DEPENDENCY_KINDS.has(e.kind)) continue;
    const list = incoming.get(e.to);
    if (list) list.push({ from: e.from, kind: e.kind });
    else incoming.set(e.to, [{ from: e.from, kind: e.kind }]);
  }
  const seen = new Set([start]);
  const out: Dependent[] = [];
  let frontier: Dependent[] = [{ id: start, hops: 0, chain: [] }];
  for (let hop = 1; hop <= maxHops; hop++) {
    const next: Dependent[] = [];
    for (const cur of frontier) {
      for (const e of incoming.get(cur.id) ?? []) {
        if (seen.has(e.from)) continue;
        seen.add(e.from);
        const d = { id: e.from, hops: hop, chain: [...cur.chain, e.kind] };
        next.push(d);
        out.push(d);
      }
    }
    frontier = next;
  }
  return out;
}

/** Tests that cover `id` (outgoing tested_by edges). */
export const testsFor = (graph: Pick<GraphData, 'edges'>, id: string): string[] => graph.edges.filter((e) => e.kind === 'tested_by' && e.from === id).map((e) => e.to);
