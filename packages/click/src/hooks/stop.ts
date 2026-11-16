// PROMPTS 153 / SPEC §12.2: the Claude Code `Stop` hook. When the agent finishes a turn, tell the daemon what it actually read and
// edited, so Click can learn which of the context it sent was useful.
//   stdin   { session_id, transcript_path, cwd, hook_event_name: 'Stop', stop_hook_active, … }
//   output  nothing, exit 0, within ~300 ms; any problem is silence
// What the agent did is read from the session transcript (JSONL). Shape verified on a real Claude Code transcript:
//   { "type": "assistant", "message": { "content": [ { "type": "tool_use", "name": "Edit", "input": { "file_path": "C:\\…" } } ] } }
//   a real prompt:  { "type": "user", "message": { "content": "text" | [ { "type": "text" } ] } }
//   a tool result:  { "type": "user", "message": { "content": [ { "type": "tool_result" } ] } }   (not a prompt)
//   other line types (api-request-blob, attachment, …) carry copies of tool_use blocks and are ignored.
// Only the work since the user's LAST prompt counts: that is the turn this Stop closes. The daemon adds what git saw change.

import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { ClickClient } from '../client.js';
import { normPath } from '../../../core/src/util/ids.js';
import { findRoot } from './hook-config.js';

export const STOP_DEADLINE_MS = 280;
const TAIL_BYTES = 6 * 1024 * 1024;
const READ_TOOLS = new Set(['Read']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface StopPayload {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  stop_hook_active?: unknown;
}

export interface TurnActivity {
  /** Absolute paths exactly as the tools were given them, deduplicated, in first-seen order. */
  read: string[];
  edited: string[];
}

/** The last `maxBytes` of a file as text, starting at a line boundary. */
export function readTail(path: string, maxBytes: number = TAIL_BYTES): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, start + off);
      if (n === 0) break;
      off += n;
    }
    const text = buf.subarray(0, off).toString('utf8');
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1); // drop the line the cut went through
  } finally {
    closeSync(fd);
  }
}

const isRealPrompt = (entry: { type?: unknown; isSidechain?: unknown; isMeta?: unknown; message?: { content?: unknown } }): boolean => {
  if (entry.type !== 'user' || entry.isMeta === true || entry.isSidechain === true) return false;
  const c = entry.message?.content;
  if (typeof c === 'string') return c.trim().length > 0;
  return Array.isArray(c) && c.some((b: { type?: string }) => b?.type === 'text') && !c.some((b: { type?: string }) => b?.type === 'tool_result');
};

/** Files read and edited by tools since the last real user prompt (the whole text if there is none). */
export function parseTranscript(text: string): TurnActivity {
  let read = new Set<string>();
  let edited = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    // cheap pre-filter: most lines are blobs we never need to parse
    const maybeTool = line.includes('"type":"assistant"') && line.includes('"tool_use"');
    const maybePrompt = line.includes('"type":"user"') && !line.includes('"tool_result"');
    if (!maybeTool && !maybePrompt) continue;
    let entry: { type?: string; isSidechain?: boolean; isMeta?: boolean; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn last line
    }
    if (maybePrompt && isRealPrompt(entry)) {
      read = new Set(); // a new turn begins
      edited = new Set();
      continue;
    }
    if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
    for (const b of entry.message.content as { type?: string; name?: string; input?: { file_path?: unknown; notebook_path?: unknown } }[]) {
      if (b?.type !== 'tool_use' || !b.name) continue;
      const p = b.input?.file_path ?? b.input?.notebook_path;
      if (typeof p !== 'string' || !p) continue;
      if (READ_TOOLS.has(b.name)) read.add(p);
      else if (EDIT_TOOLS.has(b.name)) edited.add(p);
    }
  }
  return { read: [...read], edited: [...edited] };
}

/** Root-relative posix paths; files outside the repo are dropped. */
export function relativeTo(root: string, paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    try {
      out.add(normPath(root, p));
    } catch {
      // outside the repo
    }
  }
  return [...out].sort();
}

/** Which check is worth running for what the agent changed. */
export function checkKindFor(edited: readonly string[]): 'vue-tsc' | 'vue-tsc+vitest' | 'none' {
  const code = edited.filter((f) => /\.(vue|[cm]?[jt]sx?)$/.test(f));
  if (code.length === 0) return 'none';
  return code.some((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f)) ? 'vue-tsc+vitest' : 'vue-tsc';
}

export interface StopDeps {
  env?: Record<string, string | undefined>;
  clientFor?: (root: string) => Pick<ClickClient, 'tryRequest'>;
  deadlineMs?: number;
  readTranscript?: (path: string) => string;
}

export interface StopResult {
  outcome: string;
  body?: Record<string, unknown>;
}

export async function runStopHook(raw: string, deps: StopDeps = {}): Promise<StopResult> {
  try {
    let input: StopPayload;
    try {
      input = JSON.parse(raw) as StopPayload;
    } catch {
      return { outcome: 'skip:bad-stdin' };
    }
    if (!input || typeof input !== 'object') return { outcome: 'skip:bad-stdin' };
    if (input.hook_event_name !== undefined && input.hook_event_name !== 'Stop') return { outcome: 'skip:other-event' };
    if (input.stop_hook_active === true) return { outcome: 'skip:stop-hook-active' }; // the hook's own loop guard: never act on it
    const sessionId = typeof input.session_id === 'string' && input.session_id ? input.session_id : undefined;
    const transcript = typeof input.transcript_path === 'string' ? input.transcript_path : undefined;
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    if (!sessionId || !transcript) return { outcome: 'skip:no-session' };

    const root = findRoot(cwd, deps.env ?? process.env);
    if (!root) return { outcome: 'skip:not-a-click-repo' };
    if (!deps.readTranscript && !existsSync(transcript)) return { outcome: 'skip:no-transcript' };

    const activity = parseTranscript((deps.readTranscript ?? readTail)(transcript));
    const filesRead = relativeTo(root, activity.read);
    const filesEdited = relativeTo(root, activity.edited);
    if (filesRead.length === 0 && filesEdited.length === 0) return { outcome: 'skip:no-file-activity' };

    const body = { sessionId, agent: `claude-code-${sessionId.slice(0, 4)}`, source: 'agent', filesRead, filesEdited, check: { kind: checkKindFor(filesEdited) } };
    const client = (deps.clientFor ?? ((r) => new ClickClient({ root: r })))(root);
    const answer = await client.tryRequest<{ ok?: boolean }>('/outcome', { body, deadlineMs: deps.deadlineMs ?? STOP_DEADLINE_MS, autostart: false });
    return { outcome: answer?.ok ? 'sent' : 'no-daemon', body };
  } catch (e) {
    return { outcome: `error:${e instanceof Error ? e.name : 'unknown'}` };
  }
}
