// The in-browser demo. It runs Click's own retrieval code (the same modules the daemon uses) over a bundled copy of the
// benchmark repo's graph and files: symbol matching + BM25 -> weighted RRF -> personalised PageRank over the code graph ->
// candidates -> packing to a token budget. Two things are NOT in the browser, and the page says so: query embeddings (they
// need an OpenAI key) and HydraDB itself (the daemon asks it for the graph neighbourhood; here the same graph is held in memory).

import { resolveConfig, type VariantConfig } from '../../../packages/core/src/config.js';
import { GraphHolder } from '../../../packages/core/src/graph/holder.js';
import { pprPush } from '../../../packages/core/src/graph/ppr.js';
import { weightSettings } from '../../../packages/core/src/graph/weights.js';
import { pack, type BodySource, type ChunkMeta, type Neighbour } from '../../../packages/core/src/pack/pack.js';
import { buildCandidateGraph, pprCandidates, seedCandidates } from '../../../packages/core/src/retrieve/candidates.js';
import { chunkResolver, fuseSeeds } from '../../../packages/core/src/retrieve/fuse.js';
import { buildLexicalIndex, type LexicalIndex } from '../../../packages/core/src/retrieve/lexical.js';
import { buildSymbolIndex, type SymbolIndex } from '../../../packages/core/src/retrieve/symbols.js';
import type { Candidate, Graph, PackedItem, Seed } from '../../../packages/core/src/types.js';
import type { DemoRepo } from './data/types.js';

interface Lexical {
  bm25: LexicalIndex;
  symbols: SymbolIndex;
}

export interface Answer {
  mode: 'graph' | 'plain';
  text: string;
  tokens: number;
  budget: number;
  items: PackedItem[];
  seeds: (Seed & { name: string; path: string | null })[];
  /** Why each packed node is in the answer (seed match, or the edge chain from a seed). */
  why: Map<string, { reasons: string[]; via: string[]; ppr: number }>;
  ms: number;
}

const SEED_LIST_K = 30;

export class Engine {
  private readonly holder: GraphHolder<Lexical>;
  private readonly files: Map<string, string[]>;
  private readonly chunks: Map<string, ChunkMeta>;
  private readonly resolve: (id: string) => string;
  private readonly cg;
  readonly graph: Graph;

  constructor(repo: DemoRepo) {
    this.graph = repo.graph as unknown as Graph;
    this.holder = new GraphHolder<Lexical>(this.graph, { buildLexical: (g) => ({ bm25: buildLexicalIndex(g), symbols: buildSymbolIndex(g) }) });
    this.files = new Map(Object.entries(repo.files).map(([p, t]) => [p, t.split('\n')]));
    this.chunks = new Map(this.graph.chunks.map((c) => [c.id, c]));
    this.resolve = chunkResolver(this.graph);
    this.cg = buildCandidateGraph(this.graph);
  }

  nodeName(id: string): string {
    return this.cg.nodes.get(id)?.name ?? id;
  }

  private config(mode: 'graph' | 'plain', budget: number): VariantConfig {
    // 'graph' = the V3 recipe without embeddings; 'plain' = the same seeds with no graph expansion (what a plain store gives you)
    return resolveConfig(null, mode === 'graph' ? 'V3' : 'V2', { seeds: { sources: ['symbol', 'bm25'] }, budgetTokens: budget });
  }

  private bodies(): BodySource {
    return {
      readMany: async (nodes) => {
        const out = new Map<string, { ok: true; text: string } | { ok: false; reason: 'missing' }>();
        for (const n of nodes) {
          const lines = n.path ? this.files.get(n.path) : undefined;
          out.set(n.id, lines && n.range ? { ok: true, text: lines.slice(n.range.startLine - 1, n.range.endLine).join('\n') } : { ok: false, reason: 'missing' });
        }
        return out;
      },
    };
  }

  async ask(text: string, budget: number, mode: 'graph' | 'plain'): Promise<Answer> {
    const t0 = performance.now();
    const cfg = this.config(mode, budget);
    const state = this.holder.current();
    const lists = { symbol: state.lexical.symbols.match(text, SEED_LIST_K), bm25: state.lexical.bm25.search(text, SEED_LIST_K) };
    const seeds = fuseSeeds(lists, { sources: cfg.seeds.sources, weights: cfg.seeds.weights, count: cfg.seeds.count, rrfK: cfg.seeds.rrfK, semanticReserve: 0 }, this.resolve);

    let candidates: Candidate[];
    let neighbours: ((id: string) => Neighbour[]) | undefined;
    if (cfg.expand.kind === 'none' || mode === 'plain') {
      candidates = seedCandidates(this.cg, seeds, text, cfg.candidates);
    } else {
      const csr = this.holder.weighted(weightSettings(cfg.expand), state);
      const ppr = pprPush(csr, seeds, { alpha: cfg.expand.alpha, epsilon: cfg.expand.epsilon, maxPushes: cfg.expand.maxPushes });
      candidates = pprCandidates(this.cg, csr, ppr, seeds, text, cfg.candidates);
      if (cfg.pack.neighbourSignatures) {
        neighbours = (nodeId) => {
          const u = csr.index.get(nodeId);
          if (u === undefined) return [];
          const out: Neighbour[] = [];
          for (let a = csr.offsets[u]!; a < csr.offsets[u + 1]!; a++) if (csr.w[a]! > 0) out.push({ nodeId: csr.ids[csr.targets[a]!]!, weight: csr.w[a]! });
          return out;
        };
      }
    }
    const packed = await pack(candidates, {
      budget,
      pack: { ...cfg.pack, prefix: false },
      header: { graph: this.graph.version, ms: performance.now() - t0, degraded: [] },
      nodes: this.cg.nodes,
      chunks: this.chunks,
      bodies: this.bodies(),
      ...(neighbours ? { neighbours } : {}),
    });
    const why = new Map(candidates.map((c) => [c.nodeId, { reasons: c.reasons, via: c.via, ppr: c.pprScore }]));
    return {
      mode,
      text: packed.text,
      tokens: packed.tokens,
      budget,
      items: packed.items,
      seeds: seeds.map((s) => ({ ...s, name: this.nodeName(s.nodeId), path: this.cg.nodes.get(s.nodeId)?.path ?? null })),
      why,
      ms: Math.round(performance.now() - t0),
    };
  }
}
