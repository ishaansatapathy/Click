// The shared board: what the agents working on ONE repository tell each other through the one daemon they all use.
//   notes     "I changed the auth store, do not touch it" (kind "note"), "what I learned and decided" (kind "handoff")
//   tasks     a shared list: an agent adds one, another claims it, then marks it done
//   edits     which agent changed which file (from the outcomes they report), so the next agent is warned
//   agents    who has been active lately and on what
// Click does not run the agents and has no live chat: this is a board they read and write, and the relevant part of it is added to the
// context an agent asks for (handoffs and warnings for the files that context is about), so it does not have to find out again.
//
// Everything is kept in memory and appended to `.click/board.jsonl`, so a daemon restart loses nothing. An agent names itself
// (`author`): Codex or Cursor send no session id, and the name is what the others see.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { normPath } from '../../../core/src/util/ids.js';
import type { Logger } from '../../../core/src/util/log.js';
import { countTokens } from '../../../core/src/util/tokens.js';
import { JsonlWriter } from './jsonl.js';
import { HttpError, type Route } from './server.js';

export type NoteKind = 'note' | 'handoff';
export interface Note {
  id: string;
  ts: string;
  author: string;
  kind: NoteKind;
  text: string;
  files: string[];
}
export type TaskStatus = 'open' | 'claimed' | 'done';
export interface Task {
  id: string;
  ts: string;
  title: string;
  details?: string;
  files: string[];
  status: TaskStatus;
  /** Who added it. */
  author: string;
  /** Who claimed it (and, later, finished it). */
  by?: string;
  summary?: string;
}
export interface AgentInfo {
  name: string;
  lastSeen: string;
  lastTask?: string;
  files: string[];
}

interface Edit {
  agent: string;
  files: string[];
  ts: number;
}
type BoardEvent =
  | { t: 'note'; note: Note }
  | { t: 'task'; task: Task }
  | { t: 'claim'; id: string; by: string; ts: string }
  | { t: 'done'; id: string; by: string; summary?: string; ts: string }
  | { t: 'edit'; agent: string; files: string[]; ts: number };

export const MAX_NOTES = 500;
export const MAX_TASKS = 200;
const MAX_EDITS = 500;
/** Handoffs and notes older than this are not put into a context (they stay on the board). */
export const NOTE_TTL_MS = 24 * 60 * 60 * 1000;
/** An edit older than this is not worth a warning. */
export const EDIT_TTL_MS = 30 * 60 * 1000;
const ACTIVE_MS = 15 * 60 * 1000;

const id = (prefix: string, now: number): string => `${prefix}_${now.toString(36)}_${randomBytes(3).toString('hex')}`;

function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface BoardOptions {
  /** Repository root: file paths agents send are made root-relative and anything outside is dropped. */
  root: string;
  log?: Logger | undefined;
  now?: () => number;
}

export class Board {
  private notes: Note[] = [];
  private readonly tasks = new Map<string, Task>();
  private edits: Edit[] = [];
  private readonly agents = new Map<string, { lastSeen: number; lastTask?: string; files: Set<string> }>();
  private readonly writer: JsonlWriter;
  private readonly root: string;
  private readonly now: () => number;

  constructor(
    readonly file: string,
    opts: BoardOptions,
  ) {
    this.root = opts.root;
    this.now = opts.now ?? Date.now;
    this.writer = new JsonlWriter(file, opts.log);
    this.load(opts.log);
  }

  private load(log?: Logger): void {
    if (!existsSync(this.file)) return;
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        this.apply(JSON.parse(line) as BoardEvent);
      } catch {
        log?.warn('board: skipped a line that is not an event', { file: this.file });
      }
    }
  }

  private apply(e: BoardEvent): void {
    if (e.t === 'note') {
      this.notes.push(e.note);
      if (this.notes.length > MAX_NOTES) this.notes = this.notes.slice(-MAX_NOTES);
      this.seen(e.note.author, Date.parse(e.note.ts), undefined, e.note.files);
    } else if (e.t === 'task') {
      this.tasks.set(e.task.id, e.task);
      if (this.tasks.size > MAX_TASKS) {
        const done = [...this.tasks.values()].filter((t) => t.status === 'done');
        for (const t of done.slice(0, this.tasks.size - MAX_TASKS)) this.tasks.delete(t.id); // forget the oldest finished ones first
      }
    } else if (e.t === 'claim') {
      const t = this.tasks.get(e.id);
      if (t) this.tasks.set(e.id, { ...t, status: 'claimed', by: e.by });
    } else if (e.t === 'done') {
      const t = this.tasks.get(e.id);
      if (t) this.tasks.set(e.id, { ...t, status: 'done', by: e.by, ...(e.summary ? { summary: e.summary } : {}) });
    } else if (e.t === 'edit') {
      this.edits.push({ agent: e.agent, files: e.files, ts: e.ts });
      if (this.edits.length > MAX_EDITS) this.edits = this.edits.slice(-MAX_EDITS);
      this.seen(e.agent, e.ts, undefined, e.files);
    }
  }

  private emit(e: BoardEvent): void {
    this.apply(e);
    void this.writer.append(e);
  }

  private seen(name: string, at: number, task?: string, files?: readonly string[]): void {
    const a = this.agents.get(name) ?? { lastSeen: 0, files: new Set<string>() };
    a.lastSeen = Math.max(a.lastSeen, at);
    if (task) a.lastTask = clip(task, 120);
    for (const f of files ?? []) a.files.add(f);
    if (a.files.size > 30) a.files = new Set([...a.files].slice(-30));
    this.agents.set(name, a);
  }

  /** An agent is alive (it asked for a context, wrote a note, ...). */
  touchAgent(name: string, o: { task?: string } = {}): void {
    this.seen(name, this.now(), o.task);
  }

  private rel(files: readonly string[] | undefined): string[] {
    const out = new Set<string>();
    for (const p of files ?? []) {
      try {
        out.add(normPath(this.root, p));
      } catch {
        // not ours
      }
    }
    return [...out].sort();
  }

  // ------------------------------------------------------------ notes

  addNote(n: { author: string; kind: NoteKind; text: string; files?: readonly string[] }): Note {
    const at = this.now();
    const note: Note = { id: id('n', at), ts: new Date(at).toISOString(), author: n.author, kind: n.kind, text: n.text, files: this.rel(n.files) };
    this.emit({ t: 'note', note });
    return note;
  }

  /** Newest first. `files`: only notes that name one of them. */
  listNotes(q: { since?: string; files?: readonly string[]; limit?: number; excludeAuthor?: string } = {}): Note[] {
    const since = q.since ? Date.parse(q.since) : 0;
    const want = q.files?.length ? new Set(this.rel(q.files)) : null;
    return this.notes
      .filter((n) => Date.parse(n.ts) > (Number.isFinite(since) ? since : 0) && n.author !== q.excludeAuthor && (!want || n.files.some((f) => want.has(f))))
      .reverse()
      .slice(0, q.limit ?? 20);
  }

  // ------------------------------------------------------------ tasks

  addTask(t: { author: string; title: string; details?: string; files?: readonly string[] }): Task {
    const at = this.now();
    const task: Task = { id: id('t', at), ts: new Date(at).toISOString(), title: t.title, ...(t.details ? { details: t.details } : {}), files: this.rel(t.files), status: 'open', author: t.author };
    this.emit({ t: 'task', task });
    this.seen(t.author, at);
    return task;
  }

  listTasks(status?: TaskStatus): Task[] {
    return [...this.tasks.values()].filter((t) => !status || t.status === status).sort((a, b) => a.ts.localeCompare(b.ts));
  }

  claim(taskId: string, by: string): Task {
    const t = this.tasks.get(taskId);
    if (!t) throw new HttpError(404, 'no_such_task', `no task ${taskId}`);
    if (t.status !== 'open') throw new HttpError(409, 'not_open', `task ${taskId} is already ${t.status}${t.by ? ` (${t.by})` : ''}`);
    const at = this.now();
    this.emit({ t: 'claim', id: taskId, by, ts: new Date(at).toISOString() });
    this.seen(by, at);
    return this.tasks.get(taskId)!;
  }

  done(taskId: string, by: string, summary?: string): Task {
    const t = this.tasks.get(taskId);
    if (!t) throw new HttpError(404, 'no_such_task', `no task ${taskId}`);
    if (t.status === 'done') throw new HttpError(409, 'already_done', `task ${taskId} is already done`);
    if (t.status === 'claimed' && t.by && t.by !== by) throw new HttpError(409, 'claimed_by_other', `task ${taskId} is claimed by ${t.by}`);
    const at = this.now();
    this.emit({ t: 'done', id: taskId, by, ...(summary ? { summary } : {}), ts: new Date(at).toISOString() });
    this.seen(by, at);
    return this.tasks.get(taskId)!;
  }

  // ------------------------------------------------------------ edits and agents

  /** An agent reported (through an outcome) that it changed these files. */
  recordEdits(agent: string, files: readonly string[]): void {
    const rel = this.rel(files);
    if (rel.length) this.emit({ t: 'edit', agent, files: rel, ts: this.now() });
  }

  listAgents(): (AgentInfo & { active: boolean })[] {
    const now = this.now();
    return [...this.agents.entries()]
      .map(([name, a]) => ({ name, lastSeen: new Date(a.lastSeen).toISOString(), ...(a.lastTask ? { lastTask: a.lastTask } : {}), files: [...a.files].slice(-10), active: now - a.lastSeen <= ACTIVE_MS }))
      .sort((x, y) => y.lastSeen.localeCompare(x.lastSeen));
  }

  // ------------------------------------------------------------ into the context

  /**
   * What the agent that asked for a context about `files` should also know, as text, never longer than `maxTokens`:
   * handoffs and notes (other agents', from the last day) that name those files, warnings for files another agent changed
   * lately, and a one-line pointer to the open tasks. Empty when there is nothing.
   */
  contextBlock(o: { files: ReadonlySet<string>; agent?: string | undefined; task?: string | undefined; maxTokens: number; maxChars?: number | undefined }): string {
    const now = this.now();
    const lines: string[] = [];
    // a note that names no file is about the repository, so it is matched on the task instead: it must share two words (4+ letters) with it
    const words = (s: string): Set<string> => new Set(s.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? []);
    const taskWords = o.task ? words(o.task) : new Set<string>();
    const aboutTask = (text: string): boolean => [...words(text)].filter((w) => taskWords.has(w)).length >= 2;
    const notes = this.notes
      .filter((n) => n.author !== o.agent && now - Date.parse(n.ts) <= NOTE_TTL_MS && (n.files.length ? n.files.some((f) => o.files.has(f)) : aboutTask(n.text)))
      .sort((a, b) => (a.kind === b.kind ? b.ts.localeCompare(a.ts) : a.kind === 'handoff' ? -1 : 1))
      .slice(0, 3);
    for (const n of notes) lines.push(`- ${n.author}, ${ago(now - Date.parse(n.ts))}, ${n.kind}: ${clip(n.text.replace(/\s+/g, ' '), 320)}`);
    const edited = new Map<string, { agent: string; ts: number }>();
    for (const e of this.edits) {
      if (e.agent === o.agent || now - e.ts > EDIT_TTL_MS) continue;
      for (const f of e.files) if (o.files.has(f) && (edited.get(f)?.ts ?? 0) < e.ts) edited.set(f, { agent: e.agent, ts: e.ts });
    }
    for (const [f, e] of [...edited].slice(0, 3)) lines.push(`- ⚠ ${e.agent} changed ${f} ${ago(now - e.ts)}`);
    const open = this.listTasks('open').length;
    if (open && lines.length) lines.push(`- ${open} open task${open > 1 ? 's' : ''} on the board (list_tasks)`);
    if (!lines.length) return '';

    const head = '## From other agents on this repo';
    let block = head;
    for (const line of lines) {
      const next = `${block}\n${line}`;
      if (countTokens(next) > o.maxTokens || (o.maxChars !== undefined && next.length > o.maxChars)) break;
      block = next;
    }
    return block === head ? '' : block;
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }
}

// ---------------------------------------------------------------- routes

const author = z.string().trim().min(1).max(60);
const files = z.array(z.string().min(1).max(500)).max(20).optional();
const noteBody = z.object({ author, kind: z.enum(['note', 'handoff']).default('note'), text: z.string().trim().min(1).max(2_000), files });
const taskBody = z.object({ author, title: z.string().trim().min(1).max(200), details: z.string().trim().max(2_000).optional(), files });
const claimBody = z.object({ id: z.string().min(1).max(100), author });
const doneBody = z.object({ id: z.string().min(1).max(100), author, summary: z.string().trim().max(1_000).optional() });

export function boardRoutes(board: Board): Route[] {
  return [
    {
      method: 'POST',
      path: '/notes',
      handle({ body }) {
        const b = noteBody.parse(body);
        const n = board.addNote({ author: b.author, kind: b.kind, text: b.text, ...(b.files ? { files: b.files } : {}) });
        return { ok: true, id: n.id, ts: n.ts };
      },
    },
    {
      method: 'GET',
      path: '/notes',
      handle({ query }) {
        const limit = Math.min(50, Math.max(1, Number(query.get('limit') ?? 20) || 20));
        const fs = (query.get('files') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const since = query.get('since') ?? undefined;
        return { ok: true, notes: board.listNotes({ ...(since ? { since } : {}), ...(fs.length ? { files: fs } : {}), limit }) };
      },
    },
    {
      method: 'POST',
      path: '/tasks/add',
      handle({ body }) {
        const b = taskBody.parse(body);
        const t = board.addTask({ author: b.author, title: b.title, ...(b.details ? { details: b.details } : {}), ...(b.files ? { files: b.files } : {}) });
        return { ok: true, id: t.id };
      },
    },
    {
      method: 'GET',
      path: '/tasks',
      handle({ query }) {
        const s = query.get('status');
        if (s !== null && s !== 'open' && s !== 'claimed' && s !== 'done') throw new HttpError(400, 'bad_status', 'status is open, claimed or done');
        return { ok: true, tasks: board.listTasks((s as TaskStatus | null) ?? undefined) };
      },
    },
    {
      method: 'POST',
      path: '/tasks/claim',
      handle({ body }) {
        const b = claimBody.parse(body);
        return { ok: true, task: board.claim(b.id, b.author) };
      },
    },
    {
      method: 'POST',
      path: '/tasks/done',
      handle({ body }) {
        const b = doneBody.parse(body);
        return { ok: true, task: board.done(b.id, b.author, b.summary) };
      },
    },
    { method: 'GET', path: '/agents', handle: () => ({ ok: true, agents: board.listAgents() }) },
  ];
}
