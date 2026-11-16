// PROMPTS 151 / SPEC §10, §14.2: POST /outcome, how Click finds out what an agent session really did with the context it was given.
// The Stop hook (and the MCP `report_outcome` tool, and the benchmark's simulated outcomes) say which files were read and edited;
// the daemon completes the picture with what only it knows:
//   contextIds   the ones given, else every context this session was sent
//   filesEdited  what was reported, plus what git says changed since the session began (minus files that were already dirty then)
//   diffSymbols  names of the nodes in those contexts that appear in the added or removed lines of their own file
// It appends an `outcome` event and, when nobody knows yet whether the work passed, queues the check that will.

import { z } from 'zod';
import type { LogEvent, OutcomeEvent } from '../../../core/src/contracts.js';
import { newEventId, readEvents, type EventLog } from '../../../core/src/learn/log.js';
import type { CheckQueue } from '../../../core/src/learn/check.js';
import type { ContextRecord } from '../../../core/src/contracts.js';
import type { GraphNode } from '../../../core/src/types.js';
import { normPath } from '../../../core/src/util/ids.js';
import type { Logger } from '../../../core/src/util/log.js';
import { symbolsInDiff, type GitOps } from './gitdiff.js';
import type { Route } from './server.js';
import type { SessionMemory } from './sessions.js';

const paths = z.array(z.string().min(1).max(2_000)).max(5_000);

export const outcomeRequestSchema = z
  .object({
    sessionId: z.string().min(1).max(200).optional(),
    /** Who reports (Claude Code, Codex, ...), shown to the other agents next to the files it changed. */
    agent: z.string().trim().min(1).max(60).optional(),
    contextIds: z.array(z.string().min(1).max(200)).max(500).optional(),
    taskText: z.string().max(20_000).optional(),
    filesRead: paths.optional(),
    filesEdited: paths.optional(),
    diffSymbols: z.array(z.string().min(1).max(300)).max(5_000).optional(),
    check: z.object({ kind: z.enum(['vue-tsc', 'vitest', 'vue-tsc+vitest', 'none']), files: paths.optional(), passed: z.boolean().optional() }).optional(),
    source: z.enum(['agent', 'bench-sim', 'bench-e2e']).optional(),
    repoCommit: z.string().nullable().optional(),
  })
  .refine((o) => o.sessionId !== undefined || (o.contextIds !== undefined && o.contextIds.length > 0), { message: 'give a sessionId or contextIds' });
export type OutcomeRequest = z.infer<typeof outcomeRequestSchema>;

export interface OutcomeDeps {
  root: string;
  sessions: SessionMemory;
  outcomes: Pick<EventLog<LogEvent>, 'append'>;
  /** Where the ContextRecords are (contexts.jsonl). */
  contextsFile: string;
  /** Resolves when every context appended so far is on disk. /context answers before its line is written, so an outcome that follows at once must wait for it, or it finds no contexts and the learning signal is dropped. */
  flushContexts?: () => Promise<void>;
  checks: Pick<CheckQueue, 'enqueue'> | null;
  /** Something learnable happened: an outcome with a known result. */
  onKnownResult?: () => void;
  /** The files an agent reports it changed, for the shared board's warnings to the other agents. */
  recordEdits?: (agent: string, files: string[]) => void;
  /** An automatic handoff for the other agents, written when an agent's outcome changed files (so the agent does not have to call a tool). */
  handoff?: (agent: string, text: string, files: string[]) => void;
  nodes: () => readonly GraphNode[];
  git: GitOps;
  log: Logger;
  now?: () => number;
}

export interface OutcomeResponse {
  ok: true;
  eventId: string | null;
  contexts: number;
  filesEdited: string[];
  diffSymbols: string[];
  /** Why nothing was recorded, when nothing was. */
  skipped?: 'no-contexts';
}

/** Root-relative posix paths; anything outside the repo is dropped. */
function relPaths(root: string, list: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const p of list ?? []) {
    try {
      out.add(normPath(root, p));
    } catch {
      // not ours
    }
  }
  return [...out].sort();
}

export function outcomeRoute(d: OutcomeDeps): Route {
  const now = d.now ?? Date.now;
  return {
    method: 'POST',
    path: '/outcome',
    async handle({ body }): Promise<OutcomeResponse> {
      const req = outcomeRequestSchema.parse(body);
      const session = req.sessionId ? d.sessions.peek(req.sessionId) : undefined;

      // contexts: the ones named, else everything this session was sent (memory first, then the log, which survives a daemon restart)
      await d.flushContexts?.();
      const all = (await readEvents<ContextRecord>(d.contextsFile)).events;
      const wanted = req.contextIds?.length ? new Set(req.contextIds) : session?.contextIds.length ? new Set(session.contextIds) : null;
      const contexts = all.filter((c) => (wanted ? wanted.has(c.contextId) : c.sessionId === req.sessionId));
      if (contexts.length === 0) {
        d.log.info('outcome ignored: no contexts to learn from', { sessionId: req.sessionId });
        return { ok: true, eventId: null, contexts: 0, filesEdited: [], diffSymbols: [], skipped: 'no-contexts' };
      }

      // what changed: the report, plus git since the session began (minus what was already modified then)
      const reported = relPaths(d.root, req.filesEdited);
      const commit = session?.startCommit ?? null;
      const fromGit = commit ? await d.git.changedFiles(d.root, commit) : null;
      const baseline = session?.baseline ?? new Set<string>();
      const gitEdits = (fromGit ?? []).filter((f) => !baseline.has(f));
      const filesEdited = [...new Set([...reported, ...gitEdits])].sort();

      // which of the sent symbols were touched
      const sentIds = new Set(contexts.flatMap((c) => c.items.map((i) => i.nodeId)));
      const sent = d.nodes().filter((n) => sentIds.has(n.id));
      const diff = commit ? await d.git.diff(d.root, commit) : null;
      const diffSymbols = [...new Set([...(req.diffSymbols ?? []), ...(diff ? symbolsInDiff(diff, sent) : [])])].sort();

      const check = req.check ?? { kind: 'none' as const };
      const event: OutcomeEvent = {
        v: 1,
        type: 'outcome',
        id: newEventId(now()),
        ts: new Date(now()).toISOString(),
        source: req.source ?? 'agent',
        ...(req.sessionId ? { sessionId: req.sessionId } : {}),
        contextIds: contexts.map((c) => c.contextId),
        ...(req.taskText ? { taskText: req.taskText } : {}),
        filesRead: relPaths(d.root, req.filesRead),
        filesEdited,
        diffSymbols,
        check,
        repoCommit: req.repoCommit !== undefined ? req.repoCommit : (await d.git.head(d.root)),
      };
      await d.outcomes.append(event);
      if (filesEdited.length) {
        const agent = req.agent ?? (req.sessionId ? `session-${req.sessionId.slice(0, 6)}` : 'an agent');
        d.recordEdits?.(agent, filesEdited);
        const task = (req.taskText ?? contexts[0]?.taskText ?? '').replace(/\s+/g, ' ').trim();
        const shown = filesEdited.slice(0, 6).join(', ') + (filesEdited.length > 6 ? ` and ${filesEdited.length - 6} more` : '');
        const result = check.passed === true ? ' Its check passed.' : check.passed === false ? ' Its check FAILED.' : '';
        d.handoff?.(agent, `(automatic) ${agent} ${task ? `worked on "${task.length > 140 ? `${task.slice(0, 139)}…` : task}" and ` : ''}changed ${shown}.${result}`, filesEdited);
      }
      d.log.info('outcome', { id: event.id, sessionId: req.sessionId, contexts: contexts.length, edited: filesEdited.length, diffSymbols: diffSymbols.length, check: check.kind, passed: check.passed });

      if (check.passed === undefined) d.checks?.enqueue(event);
      else d.onKnownResult?.();
      return { ok: true, eventId: event.id, contexts: contexts.length, filesEdited, diffSymbols };
    },
  };
}
