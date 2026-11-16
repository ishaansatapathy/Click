// PROMPTS 116 / SPEC §12.1: the Claude Code `UserPromptSubmit` hook. Before the agent sees a prompt, ask the daemon for the
// relevant code and hand it over as `additionalContext`. The contract with Claude Code, verified against its hooks docs:
//   stdin   { session_id, transcript_path, cwd, hook_event_name: 'UserPromptSubmit', prompt, … }
//   stdout  { "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "<text>" } }   exit 0
//   Claude Code caps a hook's context string at 10,000 characters (more is turned into a file path plus a preview), so we ask
//   the daemon for at most 9,800.
// Rule zero: this must never break the agent. Anything unexpected prints nothing and exits 0. Nothing here writes to stdout
// except the one JSON object; diagnostics go to .click/logs/hook-<date>.jsonl and never contain the prompt.
// Only this file, hook-config.ts and client.ts are bundled into dist/hooks/prompt.js: no zod, no indexer, so it starts fast.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClickClient } from '../client.js';
import { findRoot, readHookConfig } from './hook-config.js';

export const MIN_WORDS = 4;
export const HOOK_DEADLINE_MS = 1_500;
export const MAX_TASK_CHARS = 20_000;
export const MAX_CONTEXT_CHARS = 9_800;

export interface PromptHookInput {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  prompt?: unknown;
}

export interface HookDeps {
  env?: Record<string, string | undefined>;
  /** Total time for the whole hook, from now. */
  deadlineMs?: number;
  clientFor?: (root: string) => Pick<ClickClient, 'tryRequest'>;
  now?: () => number;
  /** Where to look for the repo when the payload has no cwd. */
  fallbackCwd?: string;
}

export interface HookResult {
  /** The text for stdout, or null for "print nothing". */
  stdout: string | null;
  /** Why (for the log and for tests): 'delivered', 'skip:<rule>' or 'no-context:<why>'. */
  outcome: string;
}

const skip = (rule: string): HookResult => ({ stdout: null, outcome: `skip:${rule}` });

/** The gating rules of SPEC §12.1, in order. Returns the rule that says "stay silent", or null to go ahead. */
export function gateRule(prompt: string, mode: 'always' | 'first' | 'off', alreadyHadContext: boolean): string | null {
  const p = prompt.trim();
  if (mode === 'off') return 'mode-off';
  if (p.startsWith('/')) return 'slash-command';
  if (/#noclick/i.test(p)) return 'noclick';
  if (p.split(/\s+/).filter(Boolean).length < MIN_WORDS) return 'short';
  if (mode === 'first' && alreadyHadContext) return 'already-sent';
  return null;
}

const safeId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
const markerPath = (root: string, sessionId: string): string => join(root, '.click', 'hook-sessions', safeId(sessionId));

function log(root: string | null, record: Record<string, unknown>): void {
  if (!root) return;
  try {
    const dir = join(root, '.click', 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `hook-${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({ ts: new Date().toISOString(), proc: 'hook', ...record })}\n`);
  } catch {
    // logging must never matter
  }
}

export async function runPromptHook(raw: string, deps: HookDeps = {}): Promise<HookResult> {
  const t0 = (deps.now ?? Date.now)();
  const env = deps.env ?? process.env;
  let root: string | null = null;
  const done = (r: HookResult, extra: Record<string, unknown> = {}): HookResult => {
    log(root, { outcome: r.outcome, ms: (deps.now ?? Date.now)() - t0, ...extra });
    return r;
  };
  try {
    let input: PromptHookInput;
    try {
      input = JSON.parse(raw) as PromptHookInput;
    } catch {
      return { stdout: null, outcome: 'skip:bad-stdin' };
    }
    if (!input || typeof input !== 'object' || typeof input.prompt !== 'string') return { stdout: null, outcome: 'skip:no-prompt' };
    if (input.hook_event_name !== undefined && input.hook_event_name !== 'UserPromptSubmit') return skip('other-event');
    const prompt = input.prompt;
    const sessionId = typeof input.session_id === 'string' && input.session_id ? input.session_id : undefined;
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : (deps.fallbackCwd ?? process.cwd());

    root = findRoot(cwd, env);
    if (!root) return skip('not-a-click-repo');
    const cfg = readHookConfig(root);
    const had = cfg.mode === 'first' && sessionId ? existsSync(markerPath(root, sessionId)) : false;
    const rule = gateRule(prompt, cfg.mode, had);
    if (rule) return done(skip(rule));

    const deadline = Math.max(50, (deps.deadlineMs ?? HOOK_DEADLINE_MS) - ((deps.now ?? Date.now)() - t0));
    const client = (deps.clientFor ?? ((r) => new ClickClient({ root: r })))(root);
    const packed = await client.tryRequest<{ text?: unknown; tokens?: number; degraded?: string[] }>('/context', {
      body: { task: prompt.slice(0, MAX_TASK_CHARS), source: 'hook', budgetTokens: cfg.budgetTokens, maxChars: MAX_CONTEXT_CHARS, ...(sessionId ? { sessionId, agent: `claude-code-${sessionId.slice(0, 4)}` } : {}) },
      deadlineMs: deadline,
    });
    if (!packed) return done({ stdout: null, outcome: 'no-context:daemon' });
    if (typeof packed.text !== 'string' || packed.text.length === 0) return done({ stdout: null, outcome: `no-context:${packed.degraded?.[0] ?? 'empty'}` });
    if (packed.text.length > 10_000) return done({ stdout: null, outcome: 'no-context:too-long' }); // never hand Claude Code something it would turn into a file

    if (cfg.mode === 'first' && sessionId) {
      try {
        mkdirSync(join(root, '.click', 'hook-sessions'), { recursive: true });
        writeFileSync(markerPath(root, sessionId), '');
      } catch {
        // without the marker we may send context twice: harmless
      }
    }
    const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: packed.text } });
    return done({ stdout, outcome: 'delivered' }, { tokens: packed.tokens, chars: packed.text.length, degraded: packed.degraded });
  } catch (e) {
    return done({ stdout: null, outcome: `error:${e instanceof Error ? e.name : 'unknown'}` });
  }
}
