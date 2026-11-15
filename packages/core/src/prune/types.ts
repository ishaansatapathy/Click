// PROMPTS 091 / SPEC §8.1: pruners judge how likely each candidate is needed for the task. Stretch feature (V4): off by
// default since the HydraDB OSS re-plan, but the chain is always in the pipeline so turning it on is configuration.

import type { GraphNode, Task } from '../types.js';

export type PrunerName = 'none' | 'rerank' | 'jev';

/** What a pruner sees of a candidate: `${i} | ${path} | ${name} | ${kind} | ${signature≤120} | ${ppr.toFixed(4)}`. */
export interface CandidateView {
  nodeId: string;
  line: string;
}

export interface PruneContext {
  /** Time this pruner may use. It must stop (reject) when `signal` aborts. */
  deadlineMs: number;
  signal: AbortSignal;
}

export interface PruneVerdict {
  /** Probability in [0, 1] that each candidate is needed. A missing id means "no opinion" and is treated as 1. */
  probs: Record<string, number>;
  /** Probability that the candidates together contain everything the task needs (kept for the context log). */
  enough?: number;
}

export interface Pruner {
  readonly name: PrunerName;
  prune(task: Task, cands: CandidateView[], ctx: PruneContext): Promise<PruneVerdict>;
}

/** One line per candidate. `index` is 1-based. */
export function candidateLine(index: number, node: Pick<GraphNode, 'path' | 'name' | 'kind' | 'signature'>, pprScore: number): string {
  const sig = (node.signature ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${index} | ${node.path ?? '-'} | ${node.name} | ${node.kind} | ${sig} | ${pprScore.toFixed(4)}`;
}
