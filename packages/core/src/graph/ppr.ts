// PROMPTS 088 / SPEC §6.5: personalised, weighted PageRank by forward push, with attribution.
//   Mass starts on the seeds (restart distribution). Popping a node keeps alpha of its residual as its score and spreads
//   the rest along its arcs in proportion to arc weight. A node whose arcs all weigh 0 (dangling) keeps all of it.
//   For every node we remember the single arc that delivered the most mass to it, so a result can be explained as a
//   path of edges from a seed (graph/path.ts).
// Deterministic: seeds are queued by id, arcs are visited in CSR order, the queue is FIFO.
// Runs on any weighted Csr: the 2-hop subgraph fetched from HydraDB (V3) or the full local replica (V3r, fallback).

import type { Seed } from '../types.js';
import type { Csr } from './csr.js';

export interface PprOptions {
  alpha: number; // teleport probability, 0.15
  epsilon: number; // push threshold relative to weighted degree, 1e-6
  maxPushes: number; // hard cap on work
}

/** The arc that delivered the most mass to a node: `from` is the node index it came from. */
export interface Via {
  from: number;
  arc: number;
}

export interface PprResult {
  /** Score per touched node index (only nodes with score > 0). Sums to ≤ 1; the rest is un-pushed residual. */
  scores: Map<number, number>;
  via: Map<number, Via>;
  /** Seed node indices that were found in the graph. */
  seedIdx: Set<number>;
  stats: { pushes: number; touched: number; truncated: boolean; missingSeeds: number };
}

export const PPR_DEFAULTS: PprOptions = { alpha: 0.15, epsilon: 1e-6, maxPushes: 200_000 };

export function pprPush(csr: Csr, seeds: readonly Pick<Seed, 'nodeId' | 'score'>[], opts: PprOptions = PPR_DEFAULTS): PprResult {
  const { alpha, epsilon, maxPushes } = opts;
  const n = csr.n;
  const r = new Float64Array(n);
  const p = new Float64Array(n);
  const bestIn = new Float64Array(n);
  const queued = new Uint8Array(n);
  const touchedFlag = new Uint8Array(n);
  const touched: number[] = [];
  const via = new Map<number, Via>();
  const seedIdx = new Set<number>();
  let missingSeeds = 0;

  const touch = (v: number): void => {
    if (!touchedFlag[v]) {
      touchedFlag[v] = 1;
      touched.push(v);
    }
  };

  // restart distribution over the seeds that exist in this graph, renormalised to sum 1
  const start: { id: string; idx: number; mass: number }[] = [];
  let total = 0;
  for (const s of seeds) {
    const idx = csr.index.get(s.nodeId);
    if (idx === undefined || !(s.score > 0)) {
      missingSeeds++;
      continue;
    }
    start.push({ id: s.nodeId, idx, mass: s.score });
    total += s.score;
  }
  start.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const queue: number[] = [];
  let head = 0;
  for (const s of start) {
    r[s.idx]! += s.mass / total;
    seedIdx.add(s.idx);
    touch(s.idx);
    if (!queued[s.idx]) {
      queued[s.idx] = 1;
      queue.push(s.idx);
    }
  }

  let pushes = 0;
  let truncated = false;
  while (head < queue.length) {
    if (pushes >= maxPushes) {
      truncated = true;
      break;
    }
    const u = queue[head++]!;
    queued[u] = 0;
    const ws = csr.wsum[u]!;
    const ru = r[u]!;
    if (ru <= epsilon * Math.max(ws, 1e-9)) continue;
    r[u] = 0;
    pushes++;
    if (ws === 0) {
      p[u]! += ru; // dangling: nowhere to send it, so it stays
      continue;
    }
    p[u]! += alpha * ru;
    const mass = (1 - alpha) * ru;
    for (let a = csr.offsets[u]!; a < csr.offsets[u + 1]!; a++) {
      const wa = csr.w[a]!;
      if (!(wa > 0)) continue;
      const v = csr.targets[a]!;
      const m = (mass * wa) / ws;
      r[v]! += m;
      touch(v);
      if (m > bestIn[v]!) {
        bestIn[v] = m;
        via.set(v, { from: u, arc: a });
      }
      if (!queued[v] && r[v]! > epsilon * csr.wsum[v]!) {
        queued[v] = 1;
        queue.push(v);
      }
    }
  }

  const scores = new Map<number, number>();
  for (const v of touched) if (p[v]! > 0) scores.set(v, p[v]!);
  return { scores, via, seedIdx, stats: { pushes, touched: touched.length, truncated, missingSeeds } };
}

/** Scored nodes as ids, best first, ties by id. */
export function rankScores(csr: Csr, result: Pick<PprResult, 'scores'>, k = Infinity): { id: string; score: number }[] {
  return [...result.scores]
    .map(([idx, score]) => ({ id: csr.ids[idx]!, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, k);
}
