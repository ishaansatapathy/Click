import { describe, expect, it } from 'vitest';
import { runAgents, runNotes, runTasks, type CoordinationClient, type CoordinationIo } from './coordinationCmd.js';

class FakeClient implements CoordinationClient {
  calls: { path: string; options: unknown }[] = [];
  starts = 0;
  async ensureRunning(): Promise<void> { this.starts++; }
  async request<T>(path: string, options: unknown): Promise<T> {
    this.calls.push({ path, options });
    if (path === '/notes') return { ok: true, id: 'n1', ts: '2026-11-16T12:00:00.000Z' } as T;
    if (path.startsWith('/notes?')) return { ok: true, notes: [{ id: 'n1', ts: '2026-11-16T12:00:00.000Z', author: 'Codex', kind: 'handoff', text: 'tests pass', files: ['src/a.ts'] }] } as T;
    if (path === '/tasks/add') return { ok: true, id: 't1' } as T;
    if (path === '/tasks/claim' || path === '/tasks/done') return { ok: true, task: { id: 't1', ts: '2026-11-16T12:00:00.000Z', author: 'Claude', title: 'add test', files: [], status: path.endsWith('done') ? 'done' : 'claimed', by: 'Codex' } } as T;
    if (path.startsWith('/tasks')) return { ok: true, tasks: [{ id: 't1', ts: '2026-11-16T12:00:00.000Z', author: 'Claude', title: 'add test', files: [], status: 'open' }] } as T;
    if (path === '/agents') return { ok: true, agents: [{ name: 'Codex', lastSeen: '2026-11-16T12:00:00.000Z', lastTask: 'add test', files: ['src/a.ts'], active: true }] } as T;
    throw new Error(`unexpected ${path}`);
  }
}

const capture = (): { io: CoordinationIo; out(): string; err(): string } => {
  let out = ''; let err = '';
  return { io: { out: (text) => { out += `${text}\n`; }, err: (text) => { err += `${text}\n`; } }, out: () => out, err: () => err };
};

describe('coordination CLI', () => {
  it('adds a note or handoff with an explicit author and lists notes as text or JSON', async () => {
    const client = new FakeClient();
    const a = capture();
    expect(await runNotes(['--add', 'tests pass', '--as', 'Codex', '--handoff'], a.io, '/repo', { client })).toBe(0);
    expect(client.calls[0]).toMatchObject({ path: '/notes', options: { body: { author: 'Codex', kind: 'handoff', text: 'tests pass' } } });
    expect(a.out()).toContain('handoff n1 saved');

    const b = capture();
    expect(await runNotes(['--json'], b.io, '/repo', { client })).toBe(0);
    expect(client.calls[1]?.path).toBe('/notes?limit=20');
    expect(JSON.parse(b.out()).notes[0].text).toBe('tests pass');
  });

  it('sends --files with a note or a task, and refuses --files on its own', async () => {
    const client = new FakeClient();
    const a = capture();
    expect(await runNotes(['--add', 'x', '--as', 'Codex', '--handoff', '--files', 'src/a.ts, src/b.ts'], a.io, '/repo', { client })).toBe(0);
    expect(client.calls[0]).toMatchObject({ options: { body: { files: ['src/a.ts', 'src/b.ts'] } } });
    expect(await runTasks(['--add', 'add test', '--as', 'Claude', '--files', 'src/a.ts'], a.io, '/repo', { client })).toBe(0);
    expect(client.calls[1]).toMatchObject({ path: '/tasks/add', options: { body: { files: ['src/a.ts'] } } });
    const b = capture();
    expect(await runNotes(['--files', 'src/a.ts'], b.io, '/repo', { client })).toBe(2);
    expect(b.err()).toContain('--files needs --add');
    expect(await runTasks(['--files', 'src/a.ts'], b.io, '/repo', { client })).toBe(2);
  });

  it('adds, filters, claims, and finishes tasks without anonymous writes', async () => {
    const client = new FakeClient();
    expect(await runTasks(['--add', 'add test', '--as', 'Claude'], capture().io, '/repo', { client })).toBe(0);
    expect(await runTasks(['--status', 'open'], capture().io, '/repo', { client })).toBe(0);
    expect(await runTasks(['--claim', 't1', '--as', 'Codex'], capture().io, '/repo', { client })).toBe(0);
    expect(await runTasks(['--done', 't1', '--summary', 'green'], capture().io, '/repo', { client, env: { CLICK_AGENT: 'Codex' } })).toBe(0);
    expect(client.calls.map((call) => call.path)).toEqual(['/tasks/add', '/tasks?status=open', '/tasks/claim', '/tasks/done']);
    expect(client.calls[3]?.options).toMatchObject({ body: { id: 't1', author: 'Codex', summary: 'green' } });
  });

  it('shows active agents and supports JSON', async () => {
    const client = new FakeClient();
    const text = capture();
    expect(await runAgents([], text.io, '/repo', { client })).toBe(0);
    expect(text.out()).toContain('active · Codex');
    const json = capture();
    expect(await runAgents(['--json'], json.io, '/repo', { client })).toBe(0);
    expect(JSON.parse(json.out()).agents[0].files).toEqual(['src/a.ts']);
  });

  it('rejects conflicting flags, anonymous writes, and stray values before touching the daemon', async () => {
    const client = new FakeClient();
    const cases: [typeof runNotes | typeof runTasks, string[]][] = [
      [runNotes, ['--add', 'x']],
      [runNotes, ['--handoff']],
      [runTasks, ['--claim', 't1']],
      [runTasks, ['--add', 'x', '--done', 't1', '--as', 'Codex']],
      [runTasks, ['--done', 't1', '--summary', 'x']],
    ];
    for (const [run, args] of cases) expect(await run(args, capture().io, '/repo', { client, env: {} })).toBe(2);
    expect(client.starts).toBe(0);
    expect(client.calls).toHaveLength(0);
  });

  it('prints daemon failures on stderr with a non-zero exit', async () => {
    const client: CoordinationClient = { ensureRunning: async () => undefined, request: async () => { throw new Error('offline'); } };
    const c = capture();
    expect(await runAgents([], c.io, '/repo', { client })).toBe(1);
    expect(c.err()).toContain('click agents: offline');
  });
});
