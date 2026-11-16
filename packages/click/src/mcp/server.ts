// PROMPT 170 / SPEC §13: host-neutral MCP stdio server. Claude Code, Codex, Cursor, VS Code and any other MCP host launch the
// same dist/mcp.js. Stdout belongs exclusively to JSON-RPC; diagnostics, if any, go to stderr.

import { isEntryPoint } from '../entry.js';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { resolve } from 'node:path';
import * as z from 'zod/v4';

import type { Convention, PackedContext } from '../../../core/src/types.js';
import { ClickClient } from '../client.js';
import type { ImpactResult } from '../daemon/impact.js';
import type { OutcomeResponse } from '../daemon/outcome.js';
import { VERSION } from '../version.js';
import {
  notesPath,
  tasksPath,
  type AgentsResponse,
  type NotesResponse,
  type NoteWriteResponse,
  type TasksResponse,
  type TaskStatus,
  type TaskWriteResponse,
} from './coordination.js';

interface RequestOptions { method?: 'GET' | 'POST'; body?: unknown; deadlineMs: number }
export interface McpDaemonClient {
  ensureRunning(options: { waitMs: number; ready?: boolean }): Promise<unknown>;
  request<T>(path: string, options: RequestOptions): Promise<T>;
}

export interface ClickMcpOptions {
  root?: string;
  client?: McpDaemonClient;
  env?: Record<string, string | undefined>;
  cwd?: string;
  startWaitMs?: number;
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const failure = (error: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: `Click error: ${error instanceof Error ? error.message : String(error)}` }],
});
const json = (value: unknown) => text(JSON.stringify(value));
const filesSchema = z.array(z.string().min(1).max(2_000)).max(500).optional();
const authorSchema = z.string().min(1).max(100).describe('Your agent name, for example "Claude Code", "Codex", or "Cursor".');

export function resolveMcpRoot(options: Pick<ClickMcpOptions, 'root' | 'env' | 'cwd'> = {}): string {
  const env = options.env ?? process.env;
  return resolve(options.root ?? env.CLAUDE_PROJECT_DIR ?? env.CLICK_ROOT ?? options.cwd ?? process.cwd());
}

export function createClickMcpServer(options: ClickMcpOptions = {}): McpServer {
  const root = resolveMcpRoot(options);
  const client = options.client ?? new ClickClient({ root });
  const waitMs = options.startWaitMs ?? 90_000;
  let lastContextId: string | undefined;
  const ready = async (): Promise<void> => { await client.ensureRunning({ waitMs, ready: true }); };
  const server = new McpServer(
    { name: 'click-context', version: VERSION },
    { instructions: [
      'At the start of a task, call read_notes and list_tasks so you do not repeat another agent\'s work.',
      'Call claim_task before taking a task from the shared list.',
      'Use get_context before changing code; Click retrieves repository-specific code through the local daemon.',
      'When finished, call handoff with what changed, what remains, and the relevant files.',
    ].join(' ') },
  );

  server.registerTool(
    'get_context',
    {
      description: 'Call this FIRST for any task that changes code. It returns the relevant code from this repository within a token budget, so you do not need to search the whole repo.',
      inputSchema: z.object({
        task: z.string().min(1).max(20_000).describe('The coding task or question, with enough detail to retrieve the right symbols.'),
        budgetTokens: z.number().int().min(500).max(32_000).optional().describe('Maximum context tokens; omit to use the repository default.'),
      }),
    },
    async ({ task, budgetTokens }) => {
      try {
        await ready();
        const packed = await client.request<PackedContext>('/context', {
          body: { task, source: 'mcp', ...(budgetTokens === undefined ? {} : { budgetTokens }) },
          deadlineMs: 15_000,
        });
        lastContextId = packed.contextId;
        const metadata = {
          contextId: packed.contextId,
          tokens: packed.tokens,
          items: packed.items.map(({ path, name, mode }) => ({ path, name, mode })),
        };
        return {
          content: [
            { type: 'text' as const, text: packed.text || '(Click returned no context items.)' },
            { type: 'text' as const, text: JSON.stringify(metadata) },
          ],
        };
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    'report_outcome',
    {
      description: 'Report what happened after using Click context. Call this when the task is finished so Click can learn which context helped; include the contextId returned by get_context when available.',
      inputSchema: z.object({
        contextId: z.string().min(1).max(200).optional(),
        taskText: z.string().max(20_000).optional(),
        filesEdited: z.array(z.string().min(1).max(2_000)).max(5_000).optional(),
        checkPassed: z.boolean().optional(),
      }),
    },
    async ({ contextId, taskText, filesEdited, checkPassed }) => {
      const selected = contextId ?? lastContextId;
      if (!selected) return failure(new Error('report_outcome needs contextId, or call get_context first in this MCP session'));
      try {
        await ready();
        await client.request<OutcomeResponse>('/outcome', {
          body: {
            contextIds: [selected],
            ...(taskText === undefined ? {} : { taskText }),
            ...(filesEdited === undefined ? {} : { filesEdited }),
            check: { kind: 'none', ...(checkPassed === undefined ? {} : { passed: checkPassed }) },
            source: 'agent',
          },
          deadlineMs: 10_000,
        });
        return text('ok');
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    'impact_of',
    {
      description: 'Use before changing a symbol to see what may break: dependent components, stores, composables, routes and tests, with the graph edge chain explaining each result.',
      inputSchema: z.object({
        symbol: z.string().min(1).max(300).describe('Symbol name, node id, or file path to analyze.'),
        depth: z.number().int().min(1).max(3).optional().describe('Dependency hops, from 1 to 3; defaults to 3.'),
      }),
    },
    async ({ symbol, depth }) => {
      try {
        await ready();
        const result = await client.request<ImpactResult>(`/impact?symbol=${encodeURIComponent(symbol)}${depth === undefined ? '' : `&depth=${depth}`}`, { method: 'GET', deadlineMs: 10_000 });
        if (!result.resolved) return text(`No repository symbol matched ${JSON.stringify(symbol)}.`);
        const lines = [`${result.resolved.name} (${result.resolved.path ?? result.resolved.nodeId}) · ${result.count} affected · ${result.source ?? 'no graph source'}`];
        for (const [group, items] of Object.entries(result.groups)) {
          if (!items.length) continue;
          lines.push(`\n${group}:`);
          for (const item of items) lines.push(`- ${item.path ?? item.nodeId} · ${item.name}${item.chain.length ? ` · via ${item.chain.join(' → ')}` : ''}`);
        }
        return text(lines.join('\n'));
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    'recall_conventions',
    {
      description: 'Recall the current repository conventions and when they became valid. Use before making style or architecture choices that should follow local patterns.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        await ready();
        const result = await client.request<{ items: Convention[] }>('/conventions', { method: 'GET', deadlineMs: 5_000 });
        return text(result.items.length ? result.items.map((item) => `${item.validFrom} · ${item.text}`).join('\n') : 'No current repository conventions were found.');
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    'leave_note',
    {
      description: 'Leave durable information for other agents when you discover something they should not have to rediscover. Include relevant files; use handoff instead when finishing work.',
      inputSchema: z.object({
        author: authorSchema,
        text: z.string().min(1).max(20_000),
        files: filesSchema,
      }),
    },
    async ({ author, text: noteText, files }) => {
      try {
        await ready();
        return json(await client.request<NoteWriteResponse>('/notes', {
          body: { author, kind: 'note', text: noteText, ...(files === undefined ? {} : { files }) },
          deadlineMs: 5_000,
        }));
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    'handoff',
    {
      description: 'Call when you finish or pause a task. Tell the next agent what changed, what remains, and which files matter so it can continue without re-reading your work.',
      inputSchema: z.object({
        author: authorSchema,
        text: z.string().min(1).max(20_000),
        files: filesSchema,
      }),
    },
    async ({ author, text: noteText, files }) => {
      try {
        await ready();
        return json(await client.request<NoteWriteResponse>('/notes', {
          body: { author, kind: 'handoff', text: noteText, ...(files === undefined ? {} : { files }) },
          deadlineMs: 5_000,
        }));
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    'read_notes',
    {
      description: 'Call at the START of every task, before exploring the repository. Read recent notes and handoffs so you do not repeat work another agent already did.',
      inputSchema: z.object({
        since: z.string().min(1).max(100).optional().describe('Optional ISO timestamp; only return newer notes.'),
        files: filesSchema.describe('Optional repository-relative files; only return notes touching them.'),
      }),
    },
    async ({ since, files }) => {
      try {
        await ready();
        return json(await client.request<NotesResponse>(notesPath({ since, files, limit: 20 }), { method: 'GET', deadlineMs: 5_000 }));
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    'add_task',
    {
      description: 'Add a concrete piece of work to the shared task list when another agent can take it independently.',
      inputSchema: z.object({
        author: authorSchema,
        title: z.string().min(1).max(500),
        details: z.string().max(20_000).optional(),
        files: filesSchema,
      }),
    },
    async ({ author, title, details, files }) => {
      try {
        await ready();
        return json(await client.request<TaskWriteResponse>('/tasks/add', {
          body: { author, title, ...(details === undefined ? {} : { details }), ...(files === undefined ? {} : { files }) },
          deadlineMs: 5_000,
        }));
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    'list_tasks',
    {
      description: 'Call at the start of a task and whenever idle. Check the shared list before inventing new work; claim an open task before starting it.',
      inputSchema: z.object({
        status: z.enum(['open', 'claimed', 'done']).optional(),
      }),
    },
    async ({ status }) => {
      try {
        await ready();
        return json(await client.request<TasksResponse>(tasksPath(status as TaskStatus | undefined), { method: 'GET', deadlineMs: 5_000 }));
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    'claim_task',
    {
      description: 'Call immediately BEFORE taking a task from list_tasks. This prevents another agent from starting the same work.',
      inputSchema: z.object({ id: z.string().min(1).max(200), author: authorSchema }),
    },
    async ({ id, author }) => {
      try {
        await ready();
        return json(await client.request<TaskWriteResponse>('/tasks/claim', { body: { id, author }, deadlineMs: 5_000 }));
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    'done_task',
    {
      description: 'Call after finishing a claimed task. Record a short summary, then leave a handoff when another agent may need the implementation details.',
      inputSchema: z.object({
        id: z.string().min(1).max(200),
        author: authorSchema,
        summary: z.string().max(20_000).optional(),
      }),
    },
    async ({ id, author, summary }) => {
      try {
        await ready();
        return json(await client.request<TaskWriteResponse>('/tasks/done', {
          body: { id, author, ...(summary === undefined ? {} : { summary }) },
          deadlineMs: 5_000,
        }));
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    'who_is_working',
    {
      description: 'Call before touching shared or high-conflict files to see which agents are active, their latest task, and the files they are working on.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        await ready();
        return json(await client.request<AgentsResponse>('/agents', { method: 'GET', deadlineMs: 5_000 }));
      } catch (error) { return failure(error); }
    },
  );

  return server;
}

export async function runClickMcpStdio(options: ClickMcpOptions = {}): Promise<void> {
  await serveStdio(() => createClickMcpServer(options));
}

// real paths: an MCP host may start this file through a symlink (npm's global bin on Linux and macOS)
if (isEntryPoint(import.meta.url)) {
  runClickMcpStdio().catch((error: unknown) => {
    process.stderr.write(`click MCP: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
