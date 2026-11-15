import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRESETS } from '../../../core/src/config.js';
import type { BuildResult } from '../../../core/src/indexer/build.js';
import type { PackedContext } from '../../../core/src/types.js';
import { SessionMemory, MAX_SESSIONS } from './sessions.js';
import { cleanupTemps, reference, startWorld, type World } from './testkit.js';

let ref: BuildResult;
beforeAll(async () => {
  ref = await reference();
}, 60_000);
afterAll(cleanupTemps);

const TASK = 'submitting the order fails, look at useOrderStore and the checkout button';
const worlds: World[] = [];
const world = async (o: Partial<Parameters<typeof startWorld>[0]> = {}): Promise<World> => {
  const w = await startWorld({ ref, ...o });
  worlds.push(w);
  return w;
};
afterAll(async () => {
  await Promise.all(worlds.map((w) => w.close()));
});

describe('GET /health (PROMPTS 112, SPEC §10)', () => {
  it('reports warming while the graph loads, then ready with counts, versions and HydraDB health', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = await world({ waitReady: false, seedGraph: false, config: { build: async (root, o) => (await gate, (await import('../../../core/src/indexer/build.js')).buildIndex(root, undefined, o)) } });
    const warming = await w.json('/health');
    expect(warming.status).toBe(200);
    expect(warming.body).toMatchObject({ ok: true, status: 'warming', graphVersion: null, nodes: 0, edges: 0, version: '0.0.0' });

    release();
    await w.daemon.boot();
    const ready = await w.json('/health');
    expect(ready.body).toMatchObject({ ok: true, status: 'ready', graphVersion: ref.graph.version, nodes: ref.graph.nodes.length, edges: ref.graph.edges.length, weightsVersion: null, bootSource: 'index', hydra: { ok: true } });
    expect(typeof ready.body.uptimeMs).toBe('number');
  }, 60_000);

  it('hydra health is reported without ever failing the endpoint', async () => {
    const w = await world();
    w.graph.health = () => Promise.reject(new Error('connection refused'));
    const r = await w.json('/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ready', hydra: { ok: false } });
  }, 60_000);

  it('needs the token', async () => {
    const w = await world();
    expect((await w.call('/health', {}, null)).status).toBe(401);
    expect((await w.call('/health', {}, 'nope')).status).toBe(401);
  }, 60_000);
});

describe('POST /context (PROMPTS 112)', () => {
  it('answers with a packed context, logs the record to contexts.jsonl and updates stats', async () => {
    const w = await world();
    const r = await w.json<PackedContext>('/context', { task: TASK, budgetTokens: 4000, source: 'cli' });
    expect(r.status).toBe(200);
    expect(r.body.text).toContain('useOrderStore');
    expect(r.body.tokens).toBeLessThanOrEqual(4000);
    expect(r.body.variant).toBe('delivery');
    expect(r.body.degraded).toEqual([]);
    await w.daemon.settled();

    const lines = readFileSync(join(w.root, '.click', 'contexts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ v: 1, contextId: r.body.contextId, source: 'cli', taskText: TASK, tokens: r.body.tokens, graphVersion: ref.graph.version });

    const stats = await w.json<{ last: Record<string, unknown>; totals: Record<string, number> }>('/stats');
    expect(stats.body.totals).toEqual({ contexts: 1, tokens: r.body.tokens });
    expect(stats.body.last).toMatchObject({ contextId: r.body.contextId, tokens: r.body.tokens });
    expect(JSON.parse(readFileSync(join(w.root, '.click', 'stats.json'), 'utf8')).totals.contexts).toBe(1);
  }, 60_000);

  it('during warming it answers at once with an empty context flagged warming, and logs nothing', async () => {
    const w = await world({ waitReady: false, seedGraph: false, config: { build: () => new Promise(() => undefined) } });
    const t0 = Date.now();
    const r = await w.json<PackedContext>('/context', { task: TASK });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ text: '', tokens: 0, items: [], degraded: ['warming'] });
    expect(existsSync(join(w.root, '.click', 'contexts.jsonl'))).toBe(false);
  }, 60_000);

  it('validates the request: task length, budget range, deadline, source, variant', async () => {
    const w = await world();
    for (const bad of [{}, { task: '' }, { task: 'x'.repeat(20_001) }, { task: 'ok', budgetTokens: 100 }, { task: 'ok', budgetTokens: 99_999 }, { task: 'ok', deadlineMs: 9_000 }, { task: 'ok', source: 'carrier-pigeon' }, { task: 'ok', sessionId: '' }, { task: 5 }]) {
      const r = await w.json<{ error: { code: string } }>('/context', bad);
      expect(r.status, JSON.stringify(bad).slice(0, 60)).toBe(400);
      expect(r.body.error.code).toBe('bad_request');
    }
    const v = await w.json<{ error: { code: string; message: string } }>('/context', { task: 'ok', variant: 'V99' });
    expect(v.status).toBe(400);
    expect(v.body.error.code).toBe('unknown_variant');
    expect(v.body.error.message).toContain('V3');
    expect((await w.call('/context', { method: 'POST', body: '{broken' })).status).toBe(400);
  }, 60_000);

  it('the request can pick a variant and a deadline', async () => {
    const w = await world();
    const v3 = await w.json<PackedContext>('/context', { task: TASK, variant: 'V3', deadlineMs: 900 });
    expect(v3.body.variant).toBe('V3');
    expect(v3.body.text).not.toContain('## Skeleton'); // V3 has no prefix
    const delivery = await w.json<PackedContext>('/context', { task: TASK });
    // the delivery preset decides (prompt 137 measured prefix off as the winner): the response follows it, whichever way it is set
    expect(delivery.body.text.includes('## Skeleton')).toBe(PRESETS.delivery.pack.prefix);
    expect(delivery.body.items.some((i) => i.mode === 'body')).toBe(true);
  }, 60_000);

  it('uses the repo\'s click.config.json (defaults and the variant\'s settings)', async () => {
    const w = await world({ config: { repoConfig: { budgetTokens: 1500 } } });
    const r = await w.json<PackedContext>('/context', { task: TASK });
    expect(r.body.budget).toBe(1500);
    expect(r.body.tokens).toBeLessThanOrEqual(1500);
    const explicit = await w.json<PackedContext>('/context', { task: TASK, budgetTokens: 900 });
    expect(explicit.body.budget).toBe(900);
  }, 60_000);

  it('session memory: bodies sent once become refs next time; the start commit is looked up once per session', async () => {
    let gitCalls = 0;
    const w = await world({ config: { git: async () => (gitCalls++, 'abc1234') } });
    const first = await w.json<PackedContext>('/context', { task: TASK, sessionId: 's1' });
    const second = await w.json<PackedContext>('/context', { task: TASK, sessionId: 's1' });
    expect(first.body.items.some((i) => i.mode === 'ref')).toBe(false);
    expect(second.body.items.some((i) => i.mode === 'ref')).toBe(true);
    expect(second.body.text).toContain('## Already sent this session');
    expect(gitCalls).toBe(1);
    expect(w.daemon.sessions.peek('s1')).toMatchObject({ contexts: 2, startCommit: 'abc1234' });

    const other = await w.json<PackedContext>('/context', { task: TASK, sessionId: 's2' });
    expect(other.body.items.some((i) => i.mode === 'ref')).toBe(false); // a different session has sent nothing
    expect(gitCalls).toBe(2);
    const stats = await w.json<{ session: Record<string, { contexts: number }> }>('/stats');
    expect(stats.body.session.s1!.contexts).toBe(2);
    expect(stats.body.session.s2!.contexts).toBe(1);
  }, 60_000);

  it('a repo without git records no start commit and still works', async () => {
    const w = await world({ config: { git: async () => null } });
    const r = await w.json<PackedContext>('/context', { task: TASK, sessionId: 'nogit' });
    expect(r.status).toBe(200);
    expect(w.daemon.sessions.peek('nogit')!.startCommit).toBeNull();
  }, 60_000);

  it('a slow semantic store degrades the answer, never blocks it', async () => {
    const w = await world({ storeLatency: 3_000 });
    const t0 = Date.now();
    const r = await w.json<PackedContext>('/context', { task: TASK, variant: 'V3' });
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(r.body.degraded).toContain('semantic-timeout');
    expect(r.body.text).toContain('useOrderStore');
  }, 60_000);

  it('handles concurrent requests', async () => {
    const w = await world();
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => w.json<PackedContext>('/context', { task: TASK, sessionId: `c${i % 3}` })));
    expect(rs.every((r) => r.status === 200 && r.body.tokens <= 4000)).toBe(true);
    await w.daemon.settled();
    const lines = readFileSync(join(w.root, '.click', 'contexts.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(12);
    lines.forEach((l) => JSON.parse(l)); // no interleaved writes
  }, 60_000);
});

describe('SessionMemory (PROMPTS 112)', () => {
  it('is an LRU over 200 sessions: the least recently used goes first, touching keeps one alive', () => {
    expect(MAX_SESSIONS).toBe(200);
    const m = new SessionMemory();
    for (let i = 0; i < 200; i++) m.touch(`s${i}`);
    m.touch('s0'); // s0 is now the newest
    m.touch('s200'); // evicts the oldest, which is s1
    expect(m.size).toBe(200);
    expect(m.peek('s0')).toBeDefined();
    expect(m.peek('s1')).toBeUndefined();
    expect(m.peek('s2')).toBeDefined();
  });

  it('records what was sent and counts; sent() of an unknown session or no session is undefined', () => {
    const m = new SessionMemory();
    m.record('a', ['n1', 'n2'], 100);
    m.record('a', ['n2', 'n3'], 50);
    expect([...m.sent('a')!].sort()).toEqual(['n1', 'n2', 'n3']);
    expect(m.peek('a')).toMatchObject({ contexts: 2, tokens: 150 });
    expect(m.sent('zzz')).toBeUndefined();
    expect(m.sent(undefined)).toBeUndefined();
  });
});
