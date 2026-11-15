// PROMPTS 082 / SPEC §6.2: fill a Csr's arc weights.
//   w(arc) = prior[kind] × (arc runs against the edge ? reverseFactor × reverseScale : 1) × learned multiplier(edge key)
// applyWeights never touches the structure: it returns a NEW Csr that shares offsets / targets / edgeIdx / dir / kind
// with the input and owns fresh `w` and `wsum` arrays. So the weights of a Csr that a request is already walking can
// never change under it, and re-weighting after a learning step costs one pass over the arcs, not a rebuild.
// Learned co_changed edges are ordinary edges of the Csr (merged in with learnedEdges()); a variant that does not use
// learning gives them weight 0, so they carry no mass and are absent from wsum.

import type { VariantConfig } from '../config.js';
import type { WeightsDoc } from '../types.js';
import { EDGE_KINDS, type Csr, type CsrEdge } from './csr.js';
import { effectiveWeight } from './priors.js';

export type WeightSettings = Pick<VariantConfig['expand'], 'usePriors' | 'reverseScale' | 'useLearned'>;

/** The weight-relevant part of a variant config. */
export const weightSettings = (expand: WeightSettings): WeightSettings => ({ usePriors: expand.usePriors, reverseScale: expand.reverseScale, useLearned: expand.useLearned });

/** A stable key for memoising weighted Csrs per settings + weights version. */
export const settingsKey = (s: WeightSettings): string => `${s.usePriors ? 1 : 0}|${s.reverseScale}|${s.useLearned ? 1 : 0}`;

/** Learned edges of a weights doc as Csr edges, to be merged into the structure. */
export function learnedEdges(doc: WeightsDoc | null | undefined): CsrEdge[] {
  return (doc?.addedEdges ?? []).map((e) => ({ key: e.key, from: e.from, to: e.to, kind: e.kind }));
}

export function applyWeights(csr: Csr, settings: WeightSettings, doc?: WeightsDoc | null): Csr {
  const arcs = csr.targets.length;
  const w = new Float32Array(arcs);
  const wsum = new Float32Array(csr.n);

  // prior × direction factor per (kind, direction), computed once instead of once per arc
  const base = EDGE_KINDS.map((kind) => [effectiveWeight(kind, 'out', settings), effectiveWeight(kind, 'in', settings)] as const);
  const multipliers = settings.useLearned && doc ? doc.multipliers : null;
  const learnedKeys = new Set((doc?.addedEdges ?? []).map((e) => e.key));

  for (let u = 0; u < csr.n; u++) {
    let sum = 0;
    for (let a = csr.offsets[u]!; a < csr.offsets[u + 1]!; a++) {
      const e = csr.edges[csr.edgeIdx[a]!]!;
      let weight = base[csr.kind[a]!]![csr.dir[a]!]!;
      if (learnedKeys.has(e.key) && !settings.useLearned) weight = 0;
      else if (multipliers && Object.hasOwn(multipliers, e.key)) weight *= multipliers[e.key]!;
      w[a] = weight;
      sum += w[a]!; // the float32 value actually stored, so wsum matches the arrays exactly
    }
    wsum[u] = sum;
  }
  return { ...csr, w, wsum };
}
