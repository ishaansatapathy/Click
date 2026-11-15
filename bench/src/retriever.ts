import { PRESETS, resolveConfig, type DeepPartial, type PresetName, type VariantConfig } from '../../packages/core/src/config.js';
import { GraphHolder } from '../../packages/core/src/graph/holder.js';
import { buildLexical, getContext, type Lexical } from '../../packages/core/src/pipeline.js';
import { OpenAIEmbedder } from '../../packages/core/src/store/embed.js';
import { HydraDbGraphStore } from '../../packages/core/src/store/hydradb-graph.js';
import { MemoryStore } from '../../packages/core/src/store/memory.js';
import type { Embedder, GraphStore, Store } from '../../packages/core/src/store/types.js';
import type { Graph, PackedContext } from '../../packages/core/src/types.js';
import { DiskCache } from '../../packages/core/src/util/diskCache.js';
import { fetchJson } from '../../packages/core/src/util/http.js';
import { loadRepoConfig } from '../../packages/click/src/repo-config.js';
import { pushPaths } from '../../packages/click/src/cli/push-state.js';
import type { BenchTask } from './task.js';

export type Retriever = (task: BenchTask, budget: number) => Promise<PackedContext>;

export interface InProcessRequest {
  text: string;
  budgetTokens: number;
  source: 'bench';
}

export type InProcessGetContext = (
  task: InProcessRequest,
  variant: string,
) => Promise<PackedContext>;

export function inProcessRetriever(variant: string, getContext?: InProcessGetContext): Retriever {
  return async (task, budget) => {
    if (!getContext) throw new RetrieverNotWiredError('in-process', 'prompt 094 has not shipped getContext yet');
    return getContext({ text: task.text, budgetTokens: budget, source: 'bench' }, variant);
  };
}

export interface RealInProcessRetrieverOptions {
  root: string;
  /** Reuse the runner's index instead of loading the on-disk snapshot again. */
  graphSnapshot?: Graph;
  store?: Store;
  /** `null` deliberately disables HydraDB (useful in tests and replica-only runs). */
  graph?: GraphStore | null;
  /** `null` deliberately disables embeddings. Local-only repositories always override this to disabled. */
  embedder?: Embedder | null;
  /** Benchmark-only one-knob tuning overrides, validated by the production config schema. */
  configOverrides?: DeepPartial<VariantConfig>;
}

/** Build the production pipeline dependencies once, then call core getContext directly for every benchmark task. */
export async function realInProcessRetriever(variant: string, options: RealInProcessRetrieverOptions): Promise<Retriever> {
  if (!(variant in PRESETS)) throw new Error(`Unknown in-process variant: ${variant}`);
  const repo = loadRepoConfig(options.root);
  if (!repo.ok) throw new Error(repo.error);

  const paths = pushPaths(options.root);
  const store = options.store ?? new MemoryStore(paths.memstore);
  const graph = options.graph === undefined ? defaultGraphStore() : options.graph;
  const localOnly = repo.config.privacy.localOnly;
  const embedder = localOnly || options.embedder === null
    ? undefined
    : (options.embedder ?? (process.env.OPENAI_API_KEY
        ? new OpenAIEmbedder({ cache: new DiskCache('embed', { dir: paths.cacheDir }) })
        : undefined));
  const holder = options.graphSnapshot
    ? new GraphHolder<Lexical>(options.graphSnapshot, { buildLexical })
    : undefined;
  const cfg = resolveConfig(
    localOnly
      ? { ...repo.config.variant, semantic: { ...(repo.config.variant.semantic ?? {}), mode: 'off' } }
      : repo.config.variant,
    variant as PresetName,
    options.configOverrides,
  );

  // HydraDB lazily discovers node keys. Do that once outside the timed benchmark requests; otherwise the pipeline's
  // graph deadline can repeatedly abort the cold discovery under concurrency and measure replica fallback instead.
  if (graph && options.graphSnapshot && cfg.expand.kind !== 'none' && cfg.expand.graphSource === 'hydra') {
    const degree = new Map<string, number>();
    for (const edge of options.graphSnapshot.edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }
    const seeds = [...degree].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([id]) => id);
    if (seeds.length) {
      const rows = await graph.neighbourhood(seeds, { hops: cfg.expand.hops, maxFrontier: cfg.expand.maxFrontier });
      if (!rows.length) throw new Error('HydraDB warmup returned no edges for connected benchmark seeds');
    }
  }

  return inProcessRetriever(variant, async (task) => {
    const result = await getContext(
      { text: task.text, budgetTokens: task.budgetTokens },
      cfg,
      {
        root: options.root,
        store,
        source: 'bench',
        ...(holder ? { holder } : {}),
        ...(graph ? { graph } : {}),
        ...(embedder ? { embedder } : {}),
      },
    );
    return result.packed;
  });
}

function defaultGraphStore(): GraphStore | null {
  try {
    return new HydraDbGraphStore();
  } catch {
    return null;
  }
}

export interface HttpRetrieverOptions {
  baseUrl: string;
  variant: string;
  token?: string;
  request?: typeof fetchJson<PackedContext>;
}

export function httpRetriever(options?: HttpRetrieverOptions): Retriever {
  return async (task, budget) => {
    if (!options) throw new RetrieverNotWiredError('http', 'prompt 115 has not shipped the daemon endpoint yet');
    const request = options.request ?? fetchJson<PackedContext>;
    const headers = options.token ? { authorization: `Bearer ${options.token}` } : undefined;
    return request(`${options.baseUrl.replace(/\/$/, '')}/context`, {
      method: 'POST',
      headers,
      body: { task: task.text, budgetTokens: budget, variant: options.variant, source: 'bench' },
      timeoutMs: 5_000,
      retries: 0,
    });
  };
}

export class RetrieverNotWiredError extends Error {
  constructor(readonly retriever: 'in-process' | 'http', reason: string) {
    super(`${retriever} retriever is not wired: ${reason}`);
    this.name = 'RetrieverNotWiredError';
  }
}
