import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { PackedContext } from '../../../core/src/types.js';
import { createClickMcpServer, resolveMcpRoot, type McpDaemonClient } from './server.js';

const packed: PackedContext = {
  contextId: 'ctx-1',
  text: '<click_context>relevant code</click_context>',
  tokens: 42,
  budget: 4_000,
  items: [{ nodeId: 'function:src/a.ts#save', path: 'src/a.ts', name: 'save', mode: 'body', tokens: 20 }],
  seeds: [], variant: 'delivery', configHash: 'abc', pruner: 'none', graphVersion: 'g1', weightsVersion: null,
  timings: { total: 10 }, degraded: [],
};

class FakeDaemon implements McpDaemonClient {
  calls: { path: string; options: unknown }[] = [];
  starts = 0;
  async ensureRunning(options: { waitMs: number; ready?: boolean }): Promise<void> {
    this.starts++;
    expect(options).toEqual({ waitMs: 123, ready: true });
  }
  async request<T>(path: string, options: unknown): Promise<T> {
    this.calls.push({ path, options });
    if (path === '/context') return packed as T;
    if (path === '/outcome') return { ok: true, eventId: 'e1', contexts: 1, filesEdited: [], diffSymbols: [] } as T;
    if (path.startsWith('/impact')) return {
      symbol: 'save', resolved: { nodeId: 'fn:save', name: 'save', path: 'src/a.ts', kind: 'function' }, depth: 2, source: 'hydra', count: 1,
      groups: { components: [{ nodeId: 'component:x', path: 'src/X.vue', name: 'X', kind: 'component', chain: ['component:x|calls|fn:save'], distance: 1 }], stores: [], composables: [], routes: [], tests: [], other: [] },
    } as T;
    if (path === '/conventions') return { items: [{ id: 'c1', text: 'Keep handlers small.', source: 'AGENTS.md', validFrom: '2026-11-15', validTo: null }] } as T;
    if (path === '/notes') return { ok: true, id: 'n1', ts: '2026-11-16T12:00:00.000Z' } as T;
    if (path.startsWith('/notes?')) return { ok: true, notes: [{ id: 'n1', ts: '2026-11-16T12:00:00.000Z', author: 'A', kind: 'handoff', text: 'done', files: ['src/a.ts'] }] } as T;
    if (path === '/tasks/add' || path === '/tasks/claim' || path === '/tasks/done') return { ok: true, id: 't1' } as T;
    if (path.startsWith('/tasks')) return { ok: true, tasks: [{ id: 't1', title: 'Test save', status: 'open' }] } as T;
    if (path === '/agents') return { ok: true, agents: [{ name: 'A', lastSeen: '2026-11-16T12:00:00.000Z', lastTask: 'save', files: ['src/a.ts'] }] } as T;
    throw new Error(`unexpected ${path}`);
  }
}

const close: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(close.splice(0).map((fn) => fn())); });

async function world() {
  const daemon = new FakeDaemon();
  const server = createClickMcpServer({ root: '/repo', client: daemon, startWaitMs: 123 });
  const client = new Client({ name: 'click-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(async () => { await client.close(); await server.close(); });
  return { client, daemon };
}

const texts = (result: Awaited<ReturnType<Client['callTool']>>): string[] => result.content.filter((item) => item.type === 'text').map((item) => item.text);

describe('Click MCP server (PROMPT 170)', () => {
  it('lists context and coordination tools through the SDK in-memory transport', async () => {
    const { client } = await world();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'get_context', 'report_outcome', 'impact_of', 'recall_conventions',
      'leave_note', 'handoff', 'read_notes', 'add_task', 'list_tasks', 'claim_task', 'done_task', 'who_is_working',
    ]);
    expect(tools.find((tool) => tool.name === 'get_context')?.description).toContain('FIRST');
    expect(tools.find((tool) => tool.name === 'read_notes')?.description).toContain('START');
    expect(tools.find((tool) => tool.name === 'handoff')?.description).toContain('finish');
    expect(tools.find((tool) => tool.name === 'list_tasks')?.description).toContain('idle');
    expect(tools.every((tool) => tool.description && Object.keys(tool.inputSchema).length > 0)).toBe(true);
  });

  it('get_context autostarts the daemon, proxies the budget, and returns code plus traceable metadata', async () => {
    const { client, daemon } = await world();
    const result = await client.callTool({ name: 'get_context', arguments: { task: 'change save behavior', budgetTokens: 2_000 } });
    expect(result.isError).not.toBe(true);
    const output = texts(result);
    expect(output[0]).toBe(packed.text);
    expect(JSON.parse(output[1]!)).toEqual({ contextId: 'ctx-1', tokens: 42, items: [{ path: 'src/a.ts', name: 'save', mode: 'body' }] });
    expect(daemon.calls[0]).toMatchObject({ path: '/context', options: { body: { task: 'change save behavior', budgetTokens: 2_000, source: 'mcp' } } });
    expect(daemon.starts).toBe(1);
  });

  it('reports outcomes using the last context id and proxies impact plus conventions', async () => {
    const { client, daemon } = await world();
    await client.callTool({ name: 'get_context', arguments: { task: 'change save behavior' } });
    expect(texts(await client.callTool({ name: 'report_outcome', arguments: { filesEdited: ['src/a.ts'], checkPassed: true } }))).toEqual(['ok']);
    expect(daemon.calls[1]).toMatchObject({ path: '/outcome', options: { body: { contextIds: ['ctx-1'], filesEdited: ['src/a.ts'], check: { kind: 'none', passed: true }, source: 'agent' } } });
    const impact = texts(await client.callTool({ name: 'impact_of', arguments: { symbol: 'save()', depth: 2 } }))[0]!;
    expect(daemon.calls[2]!.path).toBe('/impact?symbol=save()&depth=2');
    expect(impact).toContain('src/X.vue · X · via component:x|calls|fn:save');
    expect(texts(await client.callTool({ name: 'recall_conventions', arguments: {} }))).toEqual(['2026-11-15 · Keep handlers small.']);
  });

  it('returns a readable tool error instead of throwing when no outcome context exists', async () => {
    const { client, daemon } = await world();
    const result = await client.callTool({ name: 'report_outcome', arguments: {} });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain('call get_context first');
    expect(daemon.starts).toBe(0);
  });

  it('proxies notes, handoffs, tasks, and presence with an explicit author on every write', async () => {
    const { client, daemon } = await world();
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

    expect(JSON.parse(texts(await call('leave_note', { author: 'Codex', text: 'Use save()', files: ['src/a.ts'] }))[0]!)).toMatchObject({ id: 'n1' });
    expect(JSON.parse(texts(await call('handoff', { author: 'Claude', text: 'Implementation complete' }))[0]!)).toMatchObject({ id: 'n1' });
    expect(JSON.parse(texts(await call('read_notes', { since: '2026-11-16T11:00:00.000Z', files: ['src/a.ts', 'src/b.ts'] }))[0]!).notes).toHaveLength(1);
    expect(JSON.parse(texts(await call('add_task', { author: 'Codex', title: 'Test save', details: 'Add regression', files: ['src/a.ts'] }))[0]!)).toMatchObject({ id: 't1' });
    expect(JSON.parse(texts(await call('list_tasks', { status: 'open' }))[0]!).tasks).toHaveLength(1);
    await call('claim_task', { id: 't1', author: 'Claude' });
    await call('done_task', { id: 't1', author: 'Claude', summary: 'Tests pass' });
    expect(JSON.parse(texts(await call('who_is_working'))[0]!).agents[0].name).toBe('A');

    expect(daemon.calls.slice(-8).map((entry) => entry.path)).toEqual([
      '/notes', '/notes', '/notes?since=2026-11-16T11%3A00%3A00.000Z&files=src%2Fa.ts%2Csrc%2Fb.ts&limit=20',
      '/tasks/add', '/tasks?status=open', '/tasks/claim', '/tasks/done', '/agents',
    ]);
    expect(daemon.calls.at(-8)?.options).toMatchObject({ body: { author: 'Codex', kind: 'note' } });
    expect(daemon.calls.at(-7)?.options).toMatchObject({ body: { author: 'Claude', kind: 'handoff' } });
    expect(daemon.calls.at(-3)?.options).toMatchObject({ body: { id: 't1', author: 'Claude' } });
    expect(daemon.calls.at(-2)?.options).toMatchObject({ body: { id: 't1', author: 'Claude', summary: 'Tests pass' } });
  });

  it('rejects coordination writes without an author before calling the daemon', async () => {
    const { client, daemon } = await world();
    const result = await client.callTool({ name: 'leave_note', arguments: { text: 'anonymous' } });
    expect(result.isError).toBe(true);
    expect(daemon.calls).toHaveLength(0);
    expect(daemon.starts).toBe(0);
  });

  it('uses the host project root when present and otherwise the launch cwd', () => {
    expect(resolveMcpRoot({ env: { CLAUDE_PROJECT_DIR: '/project' }, cwd: '/elsewhere' })).toBe(resolveMcpRoot({ root: '/project' }));
    expect(resolveMcpRoot({ env: {}, cwd: '/launch' })).toBe(resolveMcpRoot({ root: '/launch' }));
  });
});
