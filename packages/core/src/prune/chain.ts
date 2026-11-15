// PROMPTS 091 / SPEC §8.1: run pruners in order, each within the time that is left; on error, timeout or a pruner that is
// not available, fall to the next and record `fallback:<from>-><to>`. The chain always ends in "none", so it always
// returns something. Then:
//   keep  = prob ≥ threshold, OR among the top `floor` candidates by PPR
//   score = pprScore × (0.5 + 0.5 × prob)      (pruning reorders as well as filters)
// Only the best `maxCandidates` by PPR are shown to a pruner; the rest are dropped (they would not fit the pack anyway).

import type { Deadline } from '../util/deadline.js';
import { withDeadline } from '../util/deadline.js';
import type { Candidate, GraphNode, Task } from '../types.js';
import { nonePruner } from './none.js';
import { candidateLine, type CandidateView, type Pruner, type PrunerName } from './types.js';

export interface PruneConfig {
  chain: readonly PrunerName[];
  threshold: number;
  floor: number;
  timeoutMs: number;
  maxCandidates: number;
}

export interface PruneOutcome {
  candidates: Candidate[];
  /** `fallback:jev->rerank`, in the order they happened. */
  fallbacks: string[];
  /** The pruner whose verdict was applied. */
  used: PrunerName;
  enough?: number;
  ms: number;
  /** How many candidates were shown to the pruner / how many it let through. */
  considered: number;
  kept: number;
}

export type PrunerRegistry = Partial<Record<PrunerName, Pruner>>;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byPpr = (a: Candidate, b: Candidate): number => b.pprScore - a.pprScore || cmp(a.nodeId, b.nodeId);

export async function runPruneChain(
  task: Task,
  cands: readonly Candidate[],
  nodes: ReadonlyMap<string, Pick<GraphNode, 'path' | 'name' | 'kind' | 'signature'>>,
  registry: PrunerRegistry,
  cfg: PruneConfig,
  deadline?: Deadline,
  now: () => number = () => performance.now(),
): Promise<PruneOutcome> {
  const t0 = now();
  const considered = [...cands].sort(byPpr).slice(0, Math.max(0, cfg.maxCandidates));
  const fallbacks: string[] = [];
  if (considered.length === 0) return { candidates: [], fallbacks, used: 'none', ms: now() - t0, considered: 0, kept: 0 };

  const views: CandidateView[] = considered.map((c, i) => ({
    nodeId: c.nodeId,
    line: nodes.has(c.nodeId) ? candidateLine(i + 1, nodes.get(c.nodeId)!, c.pprScore) : `${i + 1} | - | ${c.nodeId} | - |  | ${c.pprScore.toFixed(4)}`,
  }));

  const chain = cfg.chain.length > 0 ? cfg.chain : (['none'] as const);
  let used: PrunerName = 'none';
  let probs: Record<string, number> | null = null;
  let enough: number | undefined;

  for (let i = 0; i < chain.length && !probs; i++) {
    const name = chain[i]!;
    const next = chain[i + 1] ?? 'none';
    if (name === 'none') break; // the end of the line: handled below, needs no time
    const pruner = registry[name];
    if (!pruner) {
      fallbacks.push(`fallback:${name}->${next}`); // not configured (no key, not installed)
      continue;
    }
    const budget = Math.min(cfg.timeoutMs, deadline ? deadline.remaining() : Infinity);
    if (budget <= 0) {
      fallbacks.push(`fallback:${name}->${next}`); // no time left to even try
      continue;
    }
    const ctrl = new AbortController();
    try {
      let timedOut = false;
      const verdict = await withDeadline(pruner.prune(task, views, { deadlineMs: budget, signal: ctrl.signal }), budget, () => {
        timedOut = true;
        ctrl.abort();
        return undefined;
      });
      if (timedOut || !verdict) throw new Error('pruner timed out');
      probs = verdict.probs;
      enough = verdict.enough;
      used = name;
    } catch {
      ctrl.abort();
      fallbacks.push(`fallback:${name}->${next}`);
    }
  }
  if (!probs) probs = (await nonePruner.prune(task, views, { deadlineMs: 0, signal: new AbortController().signal })).probs;

  const out: Candidate[] = [];
  considered.forEach((c, rank) => {
    const raw = probs![c.nodeId];
    const prob = raw === undefined || Number.isNaN(raw) ? 1 : Math.min(1, Math.max(0, raw));
    if (prob < cfg.threshold && rank >= cfg.floor) return;
    out.push({ ...c, keepProb: prob, score: c.pprScore * (0.5 + 0.5 * prob) });
  });
  out.sort((a, b) => b.score - a.score || cmp(a.nodeId, b.nodeId));
  return { candidates: out, fallbacks, used, ...(enough !== undefined ? { enough } : {}), ms: now() - t0, considered: considered.length, kept: out.length };
}
