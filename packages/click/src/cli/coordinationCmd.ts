// Human and script-friendly access to the same shared board exposed through MCP.

import { resolve } from 'node:path';
import { ClickClient, ClientError } from '../client.js';
import {
  notesPath,
  tasksPath,
  type AgentsResponse,
  type NotesResponse,
  type NoteWriteResponse,
  type TasksResponse,
  type TaskMutationResponse,
  type TaskStatus,
  type TaskWriteResponse,
} from '../mcp/coordination.js';
import { parseArgs } from './args.js';

export interface CoordinationIo { out(text: string): void; err(text: string): void }
interface RequestOptions { method?: 'GET' | 'POST'; body?: unknown; deadlineMs: number }
export interface CoordinationClient {
  ensureRunning(options: { waitMs: number; ready?: boolean }): Promise<unknown>;
  request<T>(path: string, options: RequestOptions): Promise<T>;
}
export interface CoordinationDeps {
  client?: CoordinationClient;
  env?: Record<string, string | undefined>;
  startWaitMs?: number;
}

export const NOTES_USAGE = 'usage: click notes [--add "text" --as <name>] [--handoff] [--json] [--root <dir>]';
export const TASKS_USAGE = 'usage: click tasks [--add "title" --as <name>] [--claim <id> --as <name>] [--done <id> [--as <name>]] [--status open|claimed|done] [--json] [--root <dir>]';
export const AGENTS_USAGE = 'usage: click agents [--json] [--root <dir>]';

const errorText = (error: unknown): string => error instanceof ClientError ? error.message : error instanceof Error ? error.message : String(error);
const asJson = (value: unknown): string => JSON.stringify(value, null, 2);

function clientFor(cwd: string, root: string | undefined, deps: CoordinationDeps): CoordinationClient {
  return deps.client ?? new ClickClient({ root: resolve(cwd, root ?? '.') });
}

async function ready(client: CoordinationClient, deps: CoordinationDeps): Promise<void> {
  await client.ensureRunning({ waitMs: deps.startWaitMs ?? 90_000, ready: true });
}

export async function runNotes(argv: readonly string[], io: CoordinationIo, cwd = process.cwd(), deps: CoordinationDeps = {}): Promise<number> {
  const p = parseArgs(argv, { add: 'string', as: 'string', handoff: 'bool', json: 'bool', root: 'string' });
  if (p.error || p.positionals.length || (p.flags.handoff && !p.flags.add) || (p.flags.add !== undefined && !p.flags.as) || (p.flags.as !== undefined && p.flags.add === undefined)) {
    const why = p.error ?? (p.positionals.length ? `unexpected argument ${p.positionals[0]}` : p.flags.handoff ? '--handoff needs --add' : '--add needs --as <name>');
    io.err(`${why}\n${NOTES_USAGE}`);
    return 2;
  }
  const client = clientFor(cwd, p.flags.root, deps);
  try {
    await ready(client, deps);
    if (p.flags.add !== undefined) {
      const kind = p.flags.handoff ? 'handoff' : 'note';
      const result = await client.request<NoteWriteResponse>('/notes', { body: { author: p.flags.as!, kind, text: p.flags.add }, deadlineMs: 5_000 });
      io.out(p.flags.json ? asJson(result) : `${kind} ${result.id} saved at ${result.ts}`);
      return 0;
    }
    const result = await client.request<NotesResponse>(notesPath({ limit: 20 }), { method: 'GET', deadlineMs: 5_000 });
    if (p.flags.json) io.out(asJson(result));
    else if (!result.notes.length) io.out('No notes or handoffs yet.');
    else io.out(result.notes.map((note) => `${note.ts} · ${note.author} · ${note.kind}${note.files?.length ? ` · ${note.files.join(', ')}` : ''}\n  ${note.text}`).join('\n'));
    return 0;
  } catch (error) {
    io.err(`click notes: ${errorText(error)}`);
    return 1;
  }
}

function defaultAuthor(env: Record<string, string | undefined>): string | undefined {
  return env.CLICK_AGENT?.trim() || env.USERNAME?.trim() || env.USER?.trim() || undefined;
}

export async function runTasks(argv: readonly string[], io: CoordinationIo, cwd = process.cwd(), deps: CoordinationDeps = {}): Promise<number> {
  const p = parseArgs(argv, { add: 'string', as: 'string', claim: 'string', done: 'string', summary: 'string', status: 'string', json: 'bool', root: 'string' });
  const actions = [p.flags.add, p.flags.claim, p.flags.done].filter((value) => value !== undefined).length;
  const status = p.flags.status as TaskStatus | undefined;
  const badStatus = status !== undefined && !['open', 'claimed', 'done'].includes(status);
  const missingAs = (p.flags.add !== undefined || p.flags.claim !== undefined) && !p.flags.as;
  const straySummary = p.flags.summary !== undefined && p.flags.done === undefined;
  if (p.error || p.positionals.length || actions > 1 || badStatus || missingAs || straySummary || (actions && status)) {
    const why = p.error ?? (p.positionals.length ? `unexpected argument ${p.positionals[0]}` : actions > 1 ? 'choose only one of --add, --claim, or --done' : badStatus ? '--status is open, claimed, or done' : missingAs ? '--add and --claim need --as <name>' : straySummary ? '--summary needs --done' : '--status cannot be combined with a write');
    io.err(`${why}\n${TASKS_USAGE}`);
    return 2;
  }
  const env = deps.env ?? process.env;
  const doneAuthor = p.flags.done === undefined ? undefined : p.flags.as ?? defaultAuthor(env);
  if (p.flags.done !== undefined && !doneAuthor) {
    io.err(`--done needs --as <name> when CLICK_AGENT, USERNAME, and USER are unset\n${TASKS_USAGE}`);
    return 2;
  }
  const client = clientFor(cwd, p.flags.root, deps);
  try {
    await ready(client, deps);
    let result: TaskWriteResponse | TaskMutationResponse | TasksResponse;
    if (p.flags.add !== undefined) {
      result = await client.request<TaskWriteResponse>('/tasks/add', { body: { author: p.flags.as!, title: p.flags.add }, deadlineMs: 5_000 });
    } else if (p.flags.claim !== undefined) {
      result = await client.request<TaskMutationResponse>('/tasks/claim', { body: { id: p.flags.claim, author: p.flags.as! }, deadlineMs: 5_000 });
    } else if (p.flags.done !== undefined) {
      result = await client.request<TaskMutationResponse>('/tasks/done', { body: { id: p.flags.done, author: doneAuthor!, ...(p.flags.summary === undefined ? {} : { summary: p.flags.summary }) }, deadlineMs: 5_000 });
    } else {
      result = await client.request<TasksResponse>(tasksPath(status), { method: 'GET', deadlineMs: 5_000 });
    }
    if (p.flags.json) io.out(asJson(result));
    else if ('tasks' in result) {
      if (!result.tasks.length) io.out(`No ${status ?? ''} tasks.`.replace('  ', ' '));
      else io.out(result.tasks.map((task) => `${task.id} · ${task.status}${task.by ? ` · ${task.by}` : ''} · ${task.title}${task.summary ? `\n  ${task.summary}` : ''}`).join('\n'));
    } else if ('task' in result) io.out(`${result.task.id} · ${result.task.status} · ${result.task.title}`);
    else io.out(`task ${result.id} added`);
    return 0;
  } catch (error) {
    io.err(`click tasks: ${errorText(error)}`);
    return 1;
  }
}

export async function runAgents(argv: readonly string[], io: CoordinationIo, cwd = process.cwd(), deps: CoordinationDeps = {}): Promise<number> {
  const p = parseArgs(argv, { json: 'bool', root: 'string' });
  if (p.error || p.positionals.length) {
    io.err(`${p.error ?? `unexpected argument ${p.positionals[0]}`}\n${AGENTS_USAGE}`);
    return 2;
  }
  const client = clientFor(cwd, p.flags.root, deps);
  try {
    await ready(client, deps);
    const result = await client.request<AgentsResponse>('/agents', { method: 'GET', deadlineMs: 5_000 });
    if (p.flags.json) io.out(asJson(result));
    else if (!result.agents.length) io.out('No agents have checked in yet.');
    else io.out(result.agents.map((agent) => `${agent.active ? 'active' : 'seen'} · ${agent.name} · ${agent.lastSeen}${agent.lastTask ? ` · ${agent.lastTask}` : ''}${agent.files.length ? `\n  ${agent.files.join(', ')}` : ''}`).join('\n'));
    return 0;
  } catch (error) {
    io.err(`click agents: ${errorText(error)}`);
    return 1;
  }
}
