import { z } from 'zod';

import { hashOf } from './util/hash.js';

const seedSourceSchema = z.enum(['symbol', 'bm25', 'semantic']);
const prunerSchema = z.enum(['jev', 'rerank', 'none']);

export const variantConfigSchema = z.object({
  id: z.string().min(1),
  budgetTokens: z.number().int().min(500).max(32_000),
  deadlineMs: z.number().int().positive().max(5_000),
  units: z.enum(['chunk', 'symbol']),
  seeds: z.object({
    sources: z.array(seedSourceSchema),
    weights: z.object({
      symbol: z.number().nonnegative(),
      bm25: z.number().nonnegative(),
      semantic: z.number().nonnegative(),
    }),
    count: z.number().int().positive(),
    rrfK: z.number().positive(),
  }),
  semantic: z.object({
    mode: z.enum(['local', 'off']),
    k: z.number().int().positive(),
    timeoutMs: z.number().int().nonnegative(),
  }),
  expand: z.object({
    kind: z.enum(['none', 'ppr']),
    alpha: z.number().positive().max(1),
    epsilon: z.number().positive(),
    maxPushes: z.number().int().positive(),
    reverseScale: z.number().nonnegative(),
    usePriors: z.boolean(),
    useLearned: z.boolean(),
    /** 'hydra': GraphStore.neighbourhood (default). 'replica': the full local snapshot (ablation V3r, and the fallback). */
    graphSource: z.enum(['hydra', 'replica']),
    /** Neighbourhood depth fetched from HydraDB. */
    hops: z.union([z.literal(1), z.literal(2)]),
    /** Cap on the hop-2 frontier. */
    maxFrontier: z.number().int().positive(),
    /** HydraDB neighbourhood deadline; on timeout the request falls back to the replica (degraded: graph-replica). */
    graphTimeoutMs: z.number().int().positive(),
  }),
  candidates: z.number().int().positive(),
  prune: z.object({
    chain: z.array(prunerSchema).min(1),
    threshold: z.number().min(0).max(1),
    floor: z.number().int().nonnegative(),
    timeoutMs: z.number().int().nonnegative(),
    maxCandidates: z.number().int().positive(),
  }),
  pack: z.object({
    prefix: z.boolean(),
    maxBodyTokens: z.number().int().positive(),
    smallFileTokens: z.number().int().positive(),
    neighbourSignatures: z.boolean(),
    sessionDedupe: z.boolean(),
  }),
  learn: z.object({ gitCoChange: z.boolean() }),
});

export type VariantConfig = z.infer<typeof variantConfigSchema>;

export type DeepPartial<T> = T extends readonly (infer Item)[]
  ? DeepPartial<Item>[]
  : T extends object
    ? { [Key in keyof T]?: DeepPartial<T[Key]> }
    : T;

const shared: Omit<VariantConfig, 'id' | 'units' | 'seeds' | 'expand' | 'prune' | 'pack'> = {
  budgetTokens: 4_000,
  deadlineMs: 1_200,
  semantic: { mode: 'local', k: 30, timeoutMs: 400 },
  candidates: 40,
  learn: { gitCoChange: false },
};

const hybridSeeds: VariantConfig['seeds'] = {
  sources: ['symbol', 'bm25', 'semantic'],
  weights: { symbol: 1.5, bm25: 1, semantic: 1 },
  count: 8,
  rrfK: 60,
};

const noExpand: VariantConfig['expand'] = {
  kind: 'none', alpha: 0.15, epsilon: 1e-6, maxPushes: 200_000,
  reverseScale: 1, usePriors: false, useLearned: false,
  graphSource: 'hydra', hops: 2, maxFrontier: 200, graphTimeoutMs: 120,
};

const pprExpand: VariantConfig['expand'] = {
  ...noExpand, kind: 'ppr', usePriors: true,
};

const basePack: VariantConfig['pack'] = {
  prefix: false,
  maxBodyTokens: 1_200,
  smallFileTokens: 600,
  neighbourSignatures: false,
  sessionDedupe: false,
};

const noPrune: VariantConfig['prune'] = {
  chain: ['none'], threshold: 0.35, floor: 3, timeoutMs: 500, maxCandidates: 40,
};

const v1: VariantConfig = {
  ...shared,
  id: 'V1',
  units: 'chunk',
  seeds: { ...hybridSeeds, sources: ['semantic'] },
  expand: noExpand,
  prune: noPrune,
  pack: basePack,
};

const v2: VariantConfig = {
  ...shared,
  id: 'V2',
  units: 'symbol',
  seeds: hybridSeeds,
  expand: noExpand,
  prune: noPrune,
  pack: basePack,
};

const v3: VariantConfig = {
  ...shared,
  id: 'V3',
  units: 'symbol',
  seeds: hybridSeeds,
  expand: pprExpand,
  prune: noPrune,
  pack: { ...basePack, neighbourSignatures: true },
};

// Ablation: V3 over the FULL local snapshot instead of HydraDB's 2-hop neighbourhood. Answers "does the HydraDB
// fetch lose anything, and what does it cost in latency?", and is also what a request falls back to.
const v3r: VariantConfig = {
  ...v3,
  id: 'V3r',
  expand: { ...pprExpand, graphSource: 'replica' },
};

const v4: VariantConfig = {
  ...v3,
  id: 'V4',
  prune: { ...noPrune, chain: ['jev', 'rerank', 'none'] },
};

// Until Prompt 149 selects a measured winner, delivery uses the safe no-network-pruner V3 base.
const delivery: VariantConfig = {
  ...v3,
  id: 'delivery',
  pack: { ...v3.pack, prefix: true, sessionDedupe: true },
};

export const PRESETS = Object.freeze({ V1: v1, V2: v2, V3: v3, V3r: v3r, V4: v4, delivery });
export type PresetName = keyof typeof PRESETS;

export function resolveConfig(
  repoFile: DeepPartial<VariantConfig> | null | undefined,
  variant: PresetName | VariantConfig = 'delivery',
  overrides?: DeepPartial<VariantConfig>,
): VariantConfig {
  const base = typeof variant === 'string' ? PRESETS[variant] : variant;
  return variantConfigSchema.parse(deepMerge(deepMerge(base, repoFile ?? {}), overrides ?? {}));
}

export function configHash(config: VariantConfig): string {
  return hashOf(variantConfigSchema.parse(config));
}

function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  if (!isRecord(base) || !isRecord(patch)) return patch as T;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const previous = result[key];
    result[key] = isRecord(previous) && isRecord(value)
      ? deepMerge(previous, value)
      : value;
  }
  return result as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
