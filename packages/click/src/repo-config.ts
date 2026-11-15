// SPEC §3: `click.config.json` at the repo root. A partial VariantConfig (defaults for the pipeline) plus three sections the
// daemon and hooks read: `daemon` { idleMinutes }, `hook` { mode, budgetTokens }, `privacy` { localOnly }.
// This module validates with zod and is for the daemon and CLI. The prompt hook has its own dependency-free reader
// (hooks/hook-config.ts) so its bundle stays tiny.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveConfig, type DeepPartial, type VariantConfig } from '../../core/src/config.js';

const sections = z.object({
  daemon: z.object({ idleMinutes: z.number().int().min(0).max(10_080).default(240) }).default({ idleMinutes: 240 }),
  hook: z.object({ mode: z.enum(['always', 'first', 'off']).default('always'), budgetTokens: z.number().int().min(500).max(32_000).optional() }).default({ mode: 'always' }),
  privacy: z.object({ localOnly: z.boolean().default(false) }).default({ localOnly: false }),
});

export interface RepoConfig {
  /** The partial VariantConfig part of the file. */
  variant: DeepPartial<VariantConfig>;
  daemon: { idleMinutes: number };
  hook: { mode: 'always' | 'first' | 'off'; budgetTokens?: number | undefined };
  /** true: task text never leaves the machine (no OpenAI embeddings). */
  privacy: { localOnly: boolean };
}

export type RepoConfigResult = { ok: true; config: RepoConfig; found: boolean } | { ok: false; error: string };

export const CONFIG_FILE = 'click.config.json';

export function loadRepoConfig(root: string): RepoConfigResult {
  let text: string;
  try {
    text = readFileSync(join(root, CONFIG_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, found: false, config: { ...sections.parse({}), variant: {} } };
    return { ok: false, error: `cannot read ${CONFIG_FILE}: ${e instanceof Error ? e.message : String(e)}` };
  }
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be a JSON object');
    raw = parsed as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `${CONFIG_FILE} is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const { daemon, hook, privacy, ...variant } = raw;
  const s = sections.safeParse({ daemon, hook, privacy });
  if (!s.success) return { ok: false, error: `${CONFIG_FILE}: ${s.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  try {
    resolveConfig(variant as DeepPartial<VariantConfig>, 'delivery'); // validate now, not at the first request
  } catch (e) {
    return { ok: false, error: `${CONFIG_FILE}: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, found: true, config: { ...s.data, variant: variant as DeepPartial<VariantConfig> } };
}
