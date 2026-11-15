// PROMPTS 091: the pruner that prunes nothing. Every candidate is "needed" with probability 1, so the ranking stays
// exactly the PPR ranking. It is the end of every chain and the default for V1–V3.

import type { CandidateView, Pruner } from './types.js';

export const nonePruner: Pruner = {
  name: 'none',
  prune: (_task, cands: CandidateView[]) => Promise.resolve({ probs: Object.fromEntries(cands.map((c) => [c.nodeId, 1])) }),
};
