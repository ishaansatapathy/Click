// PROMPTS 089 / SPEC §6.5: explain a PPR result. For a node, follow the "best incoming arc" pointers back towards a seed
// and return the edge keys in order seed → node. At most 8 hops. The pointers can form a cycle (mass flows both ways
// along an edge), so the walk remembers what it has seen and gives up cleanly instead of looping.

import type { Csr } from './csr.js';
import type { PprResult } from './ppr.js';

export const MAX_PATH_HOPS = 8;

export interface AttributionPath {
  /** Edge keys from the seed (or the farthest node we could trace) to the node. Empty for a seed itself. */
  edgeKeys: string[];
  /** Node ids along the path, starting where the path starts and ending at the node. */
  nodeIds: string[];
  /** The seed the path starts at, or null when the walk hit a cycle, the hop limit or a node with no incoming arc. */
  seedId: string | null;
}

export function attributionPath(
  csr: Csr,
  result: Pick<PprResult, 'via' | 'seedIdx'>,
  node: number | string,
  maxHops: number = MAX_PATH_HOPS,
): AttributionPath {
  let cur = typeof node === 'string' ? csr.index.get(node) : node;
  if (cur === undefined || cur < 0 || cur >= csr.n) return { edgeKeys: [], nodeIds: [], seedId: null };

  const keys: string[] = [];
  const nodes: number[] = [cur];
  const seen = new Set<number>([cur]);
  let anchored = result.seedIdx.has(cur);

  while (!anchored && keys.length < maxHops) {
    const v = result.via.get(cur);
    if (!v || seen.has(v.from)) break; // nothing delivered mass here, or a cycle
    keys.push(csr.edges[csr.edgeIdx[v.arc]!]!.key);
    nodes.push(v.from);
    seen.add(v.from);
    cur = v.from;
    anchored = result.seedIdx.has(cur);
  }

  keys.reverse();
  nodes.reverse();
  return { edgeKeys: keys, nodeIds: nodes.map((i) => csr.ids[i]!), seedId: anchored ? csr.ids[nodes[0]!]! : null };
}
