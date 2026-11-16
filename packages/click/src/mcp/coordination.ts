// Agent-facing half of Click coordination. The daemon owns persistence and validation;
// MCP and the CLI share these response shapes and URL builders.

export type NoteKind = 'note' | 'handoff';
export type TaskStatus = 'open' | 'claimed' | 'done';

export interface AgentNote {
  id: string;
  ts: string;
  author: string;
  kind: NoteKind;
  text: string;
  files?: string[];
}

export interface SharedTask {
  id: string;
  title: string;
  details?: string;
  files?: string[];
  status: TaskStatus;
  by?: string;
  summary?: string;
}

export interface ActiveAgent {
  name: string;
  lastSeen: string;
  lastTask?: string;
  files?: string[];
}

export interface NotesResponse { ok: boolean; notes: AgentNote[] }
export interface TasksResponse { ok: boolean; tasks: SharedTask[] }
export interface AgentsResponse { ok: boolean; agents: ActiveAgent[] }
export interface NoteWriteResponse { ok: boolean; id: string; ts: string }
export interface TaskWriteResponse { ok: boolean; id: string }

export function notesPath(options: { since?: string; files?: string[]; limit?: number } = {}): string {
  const query = new URLSearchParams();
  if (options.since) query.set('since', options.since);
  if (options.files?.length) query.set('files', options.files.join(','));
  query.set('limit', String(options.limit ?? 20));
  return `/notes?${query.toString()}`;
}

export function tasksPath(status?: TaskStatus): string {
  return status ? `/tasks?status=${encodeURIComponent(status)}` : '/tasks';
}
