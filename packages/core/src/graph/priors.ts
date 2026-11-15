// SPEC §6.2: how much probability mass a random walk sends along each kind of edge, and how much less along it in reverse.
// Shared by `click map` (to show what the ranker would see) and by the PPR weights (prompt 082).
//   effective weight = prior × (direction is reverse ? reverseFactor × reverseScale : 1) × learned multiplier

import type { EdgeKind } from '../types.js';

export interface EdgePrior {
  prior: number;
  reverse: number; // factor applied when the walk follows the edge backwards
}

export const PRIORS: Readonly<Record<EdgeKind, EdgePrior>> = {
  contains: { prior: 1.0, reverse: 1.0 },
  imports: { prior: 0.6, reverse: 0.5 },
  uses_component: { prior: 1.0, reverse: 0.6 },
  passes_prop: { prior: 0.6, reverse: 0.4 },
  emits_to: { prior: 0.6, reverse: 0.6 },
  calls: { prior: 0.9, reverse: 0.5 },
  uses_store: { prior: 1.2, reverse: 0.7 },
  uses_composable: { prior: 1.1, reverse: 0.6 },
  routes_to: { prior: 0.7, reverse: 0.7 },
  has_type: { prior: 0.5, reverse: 0.3 },
  tested_by: { prior: 0.3, reverse: 0.3 },
  co_changed: { prior: 0.8, reverse: 1.0 }, // symmetric
};

export interface WeightOptions {
  /** Multiplies the reverse factors (default 1). */
  reverseScale?: number;
  /** false → every prior is 1.0 and every reverse factor 0.5 (the "no static priors" ablation). */
  usePriors?: boolean;
  /** Learned multiplier for this edge (default 1). */
  learned?: number;
}

/** Weight of following an edge of `kind` forwards ('out') or backwards ('in'). */
export function effectiveWeight(kind: EdgeKind, direction: 'out' | 'in', o: WeightOptions = {}): number {
  const p = o.usePriors === false ? { prior: 1, reverse: 0.5 } : PRIORS[kind];
  const dir = direction === 'in' ? p.reverse * (o.reverseScale ?? 1) : 1;
  return p.prior * dir * (o.learned ?? 1);
}
