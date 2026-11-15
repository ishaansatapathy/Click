// PROMPTS 112 / SPEC §10: the daemon's endpoints (health, context, stats). Reindex is added by reindex.ts, outcome and
// impact by their own prompts. Every handler validates its input with zod; the shared wrapper in server.ts turns a ZodError
// into a 400 and an HttpError into its status.
//
// /context: runs getContext against the graph state taken at the start of the request, keeps per-session memory of what was
// already sent (so the packer can send a ref instead of the body again), records the session's start commit on its first
// context, appends the ContextRecord to contexts.jsonl and updates stats.json. While the daemon is still booting it answers
// at once with an empty context flagged `warming`: the agent proceeds without us instead of waiting.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { configHash, PRESETS, resolveConfig, type DeepPartial, type PresetName, type VariantConfig } from '../../../core/src/config.js';
import type { PackedContext } from '../../../core/src/types.js';
import type { GraphStore, Embedder, Store } from '../../../core/src/store/types.js';
import { getContext } from '../../../core/src/pipeline.js';
import type { BodySource } from '../../../core/src/pack/pack.js';
import type { SkeletonProvider } from '../../../core/src/pack/prefix.js';
import type { PrunerRegistry } from '../../../core/src/prune/chain.js';
import type { Logger } from '../../../core/src/util/log.js';
import type { DaemonState } from './boot.js';
import type { JsonlWriter } from './jsonl.js';
import { HttpError, type Route } from './server.js';
import type { SessionMemory } from './sessions.js';
import type { StatsKeeper } from './stats.js';

const exec = promisify(execFile);

export const contextRequestSchema = z.object({
  task: z.string().min(1).max(20_000),
  budgetTokens: z.number().int().min(500).max(32_000).optional(),
  variant: z.string().min(1).max(40).optional(),
  sessionId: z.string().min(1).max(200).optional(),
  deadlineMs: z.number().int().min(1).max(5_000).optional(),
  source: z.enum(['hook', 'mcp', 'cli', 'bench']).optional(),
});
export type ContextRequest = z.infer<typeof contextRequestSchema>;

export interface RouteDeps {
  root: string;
  version: string;
  state: DaemonState;
  store: Store;
  graph: GraphStore | null;
  embedder?: Embedder | undefined;
  bodies: BodySource;
  prefix: SkeletonProvider;
  pruners?: PrunerRegistry | undefined;
  sessions: SessionMemory;
  stats: StatsKeeper;
  contexts: JsonlWriter;
  log: Logger;
  /** `click.config.json` of the repo (a partial VariantConfig). */
  repoConfig?: DeepPartial<VariantConfig> | null | undefined;
  defaultVariant?: PresetName;
  now?: () => number;
  /** HEAD of the repo, or null. Injectable for tests. */
  git?: (root: string) => Promise<string | null>;
}

export async function gitHead(root: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 1_000, windowsHide: true });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function warmingContext(cfg: VariantConfig, budget: number, ms: number): PackedContext {
  return {
    contextId: `ctx_warming_${Date.now().toString(36)}`, text: '', tokens: 0, budget, items: [], seeds: [], variant: cfg.id, configHash: configHash(cfg),
    pruner: 'none', graphVersion: '', weightsVersion: null, timings: { total: ms }, degraded: ['warming'],
  };
}

export function createRoutes(d: RouteDeps): Route[] {
  const now = d.now ?? Date.now;
  const git = d.git ?? gitHead;
  const variants = Object.keys(PRESETS);

  const health: Route = {
    method: 'GET',
    path: '/health',
    async handle() {
      const st = d.state.holder?.current();
      const hydra = await d.state.hydraHealth();
      return {
        ok: true,
        status: d.state.status,
        version: d.version,
        graphVersion: st?.graph.version ?? null,
        nodes: st?.graph.nodes.length ?? 0,
        edges: st?.graph.edges.length ?? 0,
        weightsVersion: st?.weightsVersion ?? null,
        uptimeMs: now() - d.state.startedAt,
        bootSource: d.state.source,
        bootMs: d.state.bootMs,
        hydra: { ok: hydra.ok, ...(hydra.version ? { version: hydra.version } : {}), ...(hydra.detail ? { detail: hydra.detail } : {}) },
      };
    },
  };

  const context: Route = {
    method: 'POST',
    path: '/context',
    async handle({ body, id }) {
      const req = contextRequestSchema.parse(body);
      const variant = req.variant ?? d.defaultVariant ?? 'delivery';
      if (!variants.includes(variant)) throw new HttpError(400, 'unknown_variant', `unknown variant "${variant}" (try ${variants.join(', ')})`);
      const t0 = now();
      let cfg: VariantConfig;
      try {
        cfg = resolveConfig(d.repoConfig, variant as PresetName, { ...(req.deadlineMs ? { deadlineMs: req.deadlineMs } : {}) });
      } catch (e) {
        throw new HttpError(500, 'bad_config', `click.config.json is invalid: ${e instanceof Error ? e.message : String(e)}`);
      }
      const budget = req.budgetTokens ?? cfg.budgetTokens;

      const holder = d.state.status === 'ready' ? d.state.holder : null;
      if (!holder) return warmingContext(cfg, budget, now() - t0);

      const session = req.sessionId ? d.sessions.touch(req.sessionId) : undefined;
      // the session's first context records where the repo was, so the Stop hook can tell what the agent changed
      const startCommit = session && session.startCommit === undefined ? git(d.root).then((c) => void (session.startCommit = c), () => void (session.startCommit = null)) : undefined;

      const { packed, record } = await getContext(
        { text: req.task, budgetTokens: budget, ...(req.sessionId ? { sessionId: req.sessionId } : {}) },
        cfg,
        {
          store: d.store, root: d.root, holder, bodies: d.bodies, prefix: d.prefix, now,
          source: req.source ?? 'api',
          sent: (sid) => d.sessions.sent(sid),
          ...(d.graph ? { graph: d.graph } : {}),
          ...(d.embedder ? { embedder: d.embedder } : {}),
          ...(d.pruners ? { pruners: d.pruners } : {}),
        },
      );
      await startCommit;

      if (req.sessionId) {
        d.sessions.record(req.sessionId, packed.items.filter((i) => i.mode === 'body' || i.mode === 'file').map((i) => i.nodeId), packed.tokens);
      }
      void d.contexts.append(record);
      d.stats.record(packed, req.sessionId, now() - t0);
      d.log.info('context', { id, contextId: packed.contextId, variant: packed.variant, tokens: packed.tokens, items: packed.items.length, ms: Math.round(now() - t0), timings: packed.timings, degraded: packed.degraded, source: record.source });
      return packed;
    },
  };

  const stats: Route = { method: 'GET', path: '/stats', handle: () => d.stats.get() };

  return [health, context, stats];
}
