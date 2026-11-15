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
  it('lists exactly four agent-oriented tools through the SDK in-memory transport', async () => {
    const { client } = await world();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['get_context', 'report_outcome', 'impact_of', 'recall_conventions']);
    expect(tools.find((tool) => tool.name === 'get_context')?.description).toContain('FIRST');
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

  it('uses the host project root when present and otherwise the launch cwd', () => {
    expect(resolveMcpRoot({ env: { CLAUDE_PROJECT_DIR: '/project' }, cwd: '/elsewhere' })).toBe(resolveMcpRoot({ root: '/project' }));
    expect(resolveMcpRoot({ env: {}, cwd: '/launch' })).toBe(resolveMcpRoot({ root: '/launch' }));
  });
});
