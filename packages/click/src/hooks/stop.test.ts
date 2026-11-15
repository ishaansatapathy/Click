import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bundle } from '../build/bundle.js';
import { writeInfo } from '../daemon/lifecycle.js';
import { startHttp, type HttpHandle } from '../daemon/server.js';
import { OPT_IN_FILE } from './hook-config.js';
import { checkKindFor, parseTranscript, readTail, relativeTo, runStopHook } from './stop.js';

// ---- a transcript in the shape of a real Claude Code one (verified on a 20 MB session file)
const J = (o: unknown): string => JSON.stringify(o);
const prompt = (text: string, extra: object = {}) => J({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid: 'u', timestamp: 't', sessionId: 's', ...extra });
const promptBlocks = (text: string) => J({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'text', text }] } });
const toolUse = (name: string, input: object, extra: object = {}) => J({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'toolu_1', name, input }] }, ...extra });
const toolResult = () => J({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] } });
const blob = (name: string, input: object) => J({ type: 'api-request-blob', body: J({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', name, input }] }] }) }); // a decoy: copies of tool_use live here too

const ROOT_WIN = 'C:\\Users\\me\\proj';
const abs = (rel: string) => `${ROOT_WIN}\\${rel.replace(/\//g, '\\')}`;

describe('parseTranscript (PROMPTS 153)', () => {
  it('collects Read, and Edit / Write / MultiEdit / NotebookEdit paths, from tool_use blocks of assistant entries', () => {
    const t = [
      prompt('fix the logout bug please'),
      toolUse('Read', { file_path: abs('src/a.ts') }),
      toolResult(),
      toolUse('Edit', { file_path: abs('src/a.ts'), old_string: 'x', new_string: 'y' }),
      toolUse('Write', { file_path: abs('src/new.ts'), content: 'z' }),
      toolUse('MultiEdit', { file_path: abs('src/m.ts'), edits: [] }),
      toolUse('NotebookEdit', { notebook_path: abs('nb.ipynb'), new_source: '' }),
      toolUse('Bash', { command: 'ls' }),
      toolUse('Grep', { pattern: 'x', path: abs('src') }),
    ].join('\n');
    expect(parseTranscript(t)).toEqual({ read: [abs('src/a.ts')], edited: [abs('src/a.ts'), abs('src/new.ts'), abs('src/m.ts'), abs('nb.ipynb')] });
  });

  it('only the turn since the last real prompt counts; tool results and meta lines are not prompts', () => {
    const t = [
      prompt('first task'),
      toolUse('Edit', { file_path: abs('src/old.ts') }),
      prompt('second task'),
      toolUse('Read', { file_path: abs('src/r.ts') }),
      toolResult(),
      prompt('<system-reminder>hook output</system-reminder>', { isMeta: true }),
      toolUse('Edit', { file_path: abs('src/e.ts') }),
      toolResult(),
    ].join('\n');
    expect(parseTranscript(t)).toEqual({ read: [abs('src/r.ts')], edited: [abs('src/e.ts')] });
    const blocks = [prompt('a'), toolUse('Edit', { file_path: abs('src/1.ts') }), promptBlocks('b'), toolUse('Edit', { file_path: abs('src/2.ts') })].join('\n');
    expect(parseTranscript(blocks).edited).toEqual([abs('src/2.ts')]); // text-block prompts are prompts too
  });

  it('a subagent\'s file work counts (it is the agent\'s work), but a subagent\'s own prompt does not start a new turn', () => {
    const t = [prompt('task'), toolUse('Edit', { file_path: abs('src/main.ts') }), prompt('subagent instruction', { isSidechain: true }), toolUse('Edit', { file_path: abs('src/side.ts') }, { isSidechain: true })].join('\n');
    expect(parseTranscript(t).edited).toEqual([abs('src/main.ts'), abs('src/side.ts')]);
  });

  it('ignores the copies of tool_use that other line types carry, and survives garbage and a torn last line', () => {
    const t = [prompt('task'), blob('Edit', { file_path: abs('src/decoy.ts') }), 'not json at all', '', toolUse('Edit', { file_path: abs('src/real.ts') }), '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_pa'].join('\n');
    expect(parseTranscript(t).edited).toEqual([abs('src/real.ts')]);
  });

  it('no prompt in the text (a tail cut mid-turn): everything in it counts; an empty transcript is empty; duplicates collapse', () => {
    expect(parseTranscript([toolUse('Read', { file_path: abs('a.ts') }), toolUse('Read', { file_path: abs('a.ts') })].join('\n'))).toEqual({ read: [abs('a.ts')], edited: [] });
    expect(parseTranscript('')).toEqual({ read: [], edited: [] });
    expect(parseTranscript(toolUse('Edit', { file_path: 42 }))).toEqual({ read: [], edited: [] });
  });
});

describe('helpers (PROMPTS 153)', () => {
  it('relativeTo gives repo-relative posix paths from Windows or posix absolute paths and drops files outside the repo', () => {
    expect(relativeTo(ROOT_WIN, [abs('src/a.ts'), 'C:/Users/me/proj/src/b.ts', 'src/c.ts', 'C:\\Users\\me\\elsewhere\\x.ts', '../up.ts'])).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(relativeTo('/home/me/proj', ['/home/me/proj/src/a.ts', '/etc/passwd'])).toEqual(['src/a.ts']);
  });

  it('checkKindFor: code edits get vue-tsc, edited tests add vitest, prose and config get nothing', () => {
    expect(checkKindFor(['src/a.vue'])).toBe('vue-tsc');
    expect(checkKindFor(['src/a.ts', 'src/a.test.ts'])).toBe('vue-tsc+vitest');
    expect(checkKindFor(['README.md', 'package.json'])).toBe('none');
    expect(checkKindFor([])).toBe('none');
  });

  it('readTail returns whole small files, and for big ones starts at a line boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'click-tail-'));
    try {
      const f = join(dir, 't.jsonl');
      const lines = Array.from({ length: 200 }, (_, i) => `{"n":${i},"pad":"${'x'.repeat(100)}"}`);
      writeFileSync(f, `${lines.join('\n')}\n`);
      expect(readTail(f)).toBe(`${lines.join('\n')}\n`);
      const tail = readTail(f, 1_000);
      expect(tail.length).toBeLessThanOrEqual(1_000);
      expect(tail.startsWith('{"n":')).toBe(true);
      expect(tail.endsWith('\n')).toBe(true);
      JSON.parse(tail.split('\n')[0]!); // the first line is whole
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runStopHook (PROMPTS 153)', () => {
  let root: string;
  const mk = (): void => {
    root = mkdtempSync(join(tmpdir(), 'click-stop-'));
    mkdirSync(join(root, '.click'));
    writeFileSync(join(root, OPT_IN_FILE), '');
  };
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const transcript = (r: string) =>
    [prompt('do it'), toolUse('Read', { file_path: join(r, 'src', 'a.ts') }), toolUse('Edit', { file_path: join(r, 'src', 'a.ts') }), toolUse('Edit', { file_path: join(r, 'src', 'a.test.ts') })].join('\n');
  const payload = (over: Record<string, unknown> = {}) => JSON.stringify({ session_id: 's1', transcript_path: 'T', cwd: root, hook_event_name: 'Stop', stop_hook_active: false, ...over });
  type Call = { path: string; body: Record<string, unknown>; deadlineMs: number; autostart: boolean | undefined };
  const fake = (answer: unknown, calls: Call[] = []) => () => ({ tryRequest: async (path: string, o: { body?: unknown; deadlineMs: number; autostart?: boolean }) => (calls.push({ path, body: o.body as Record<string, unknown>, deadlineMs: o.deadlineMs, autostart: o.autostart }), answer as never) });

  it('posts what the agent read and edited this turn to /outcome, without ever starting a daemon', async () => {
    mk();
    const calls: Call[] = [];
    const r = await runStopHook(payload(), { env: {}, readTranscript: () => transcript(root), clientFor: fake({ ok: true }, calls) });
    expect(r.outcome).toBe('sent');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: '/outcome', autostart: false });
    expect(calls[0]!.deadlineMs).toBeLessThanOrEqual(300);
    expect(calls[0]!.body).toEqual({ sessionId: 's1', source: 'agent', filesRead: ['src/a.ts'], filesEdited: ['src/a.test.ts', 'src/a.ts'], check: { kind: 'vue-tsc+vitest' } });
  });

  it('stop_hook_active (the hook\'s own loop guard) exits at once; so do other events, bad input and non-Click repos', async () => {
    mk();
    const calls: Call[] = [];
    const deps = { env: {}, readTranscript: () => transcript(root), clientFor: fake({ ok: true }, calls) };
    expect((await runStopHook(payload({ stop_hook_active: true }), deps)).outcome).toBe('skip:stop-hook-active');
    expect((await runStopHook(payload({ hook_event_name: 'UserPromptSubmit' }), deps)).outcome).toBe('skip:other-event');
    for (const raw of ['', 'nope', '[]', '{}', payload({ session_id: undefined }), payload({ transcript_path: undefined })]) {
      expect((await runStopHook(raw, deps)).outcome, raw).toMatch(/^skip:/);
    }
    const bare = mkdtempSync(join(tmpdir(), 'click-stop-bare-'));
    try {
      expect((await runStopHook(payload({ cwd: bare }), deps)).outcome).toBe('skip:not-a-click-repo');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
    expect(calls).toHaveLength(0);
  });

  it('a turn with no file activity sends nothing; a daemon that is not running or errors is silence, never a throw', async () => {
    mk();
    expect((await runStopHook(payload(), { env: {}, readTranscript: () => [prompt('just a question')].join('\n'), clientFor: fake({ ok: true }) })).outcome).toBe('skip:no-file-activity');
    expect((await runStopHook(payload(), { env: {}, readTranscript: () => transcript(root), clientFor: fake(null) })).outcome).toBe('no-daemon');
    const boom = await runStopHook(payload(), { env: {}, readTranscript: () => transcript(root), clientFor: () => ({ tryRequest: () => Promise.reject(new Error('x')) }) });
    expect(boom.outcome).toBe('error:Error');
    const missing = await runStopHook(payload({ transcript_path: join(root, 'missing.jsonl') }), { env: {} });
    expect(missing.outcome).toBe('skip:no-transcript');
  });

  it('files outside the repo are dropped; edits to non-code files ask for no check', async () => {
    mk();
    const t = [prompt('go'), toolUse('Edit', { file_path: join(root, 'README.md') }), toolUse('Read', { file_path: join(tmpdir(), 'elsewhere', 'x.ts') })].join('\n');
    const calls: Call[] = [];
    await runStopHook(payload(), { env: {}, readTranscript: () => t, clientFor: fake({ ok: true }, calls) });
    expect(calls[0]!.body).toMatchObject({ filesRead: [], filesEdited: ['README.md'], check: { kind: 'none' } });
  });
});

// ---- the real bundled process
describe('dist/hooks/stop.js as a real process (PROMPTS 153)', () => {
  let out: string;
  let hook: string;
  const dirs: string[] = [];
  const handles: HttpHandle[] = [];
  const tmp = (p: string): string => {
    const d = mkdtempSync(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };
  beforeAll(async () => {
    out = tmp('click-stopbundle-');
    await bundle({ outdir: out, hooksOnly: true });
    hook = join(out, 'hooks', 'stop.js');
  }, 60_000);
  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.close()));
  });
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  const run = (stdin: string, cwd: string): Promise<{ code: number | null; stdout: string; ms: number }> =>
    new Promise((resolve, reject) => {
      const t0 = performance.now();
      const child = spawn(process.execPath, [hook], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, ms: performance.now() - t0 }));
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin);
    });

  it('reads a real-shaped transcript, tells the daemon the turn\'s files within the deadline, prints nothing, exits 0', async () => {
    const repo = tmp('click-stoprepo-');
    mkdirSync(join(repo, '.click'));
    const seen: Record<string, unknown>[] = [];
    const h = await startHttp({
      token: 'tok',
      routes: [
        { method: 'GET', path: '/health', handle: () => ({ ok: true, status: 'ready', version: '0', graphVersion: 'g', nodes: 1, edges: 1 }) },
        { method: 'POST', path: '/outcome', handle: ({ body }) => (seen.push(body as Record<string, unknown>), { ok: true }) },
      ],
    });
    handles.push(h);
    await writeInfo(join(repo, '.click'), { v: 1, pid: process.pid, port: h.port, token: 'tok', startedAt: 't', version: '0', root: repo });
    const tPath = join(repo, 'transcript.jsonl');
    writeFileSync(tPath, `${[prompt('go'), toolUse('Read', { file_path: join(repo, 'src', 'a.ts') }), toolUse('Edit', { file_path: join(repo, 'src', 'a.ts') }), blob('Edit', { file_path: join(repo, 'decoy.ts') })].join('\n')}\n`);
    const r = await run(JSON.stringify({ session_id: 'sess', transcript_path: tPath, cwd: repo, hook_event_name: 'Stop', stop_hook_active: false }), repo);
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    expect(seen).toEqual([{ sessionId: 'sess', source: 'agent', filesRead: ['src/a.ts'], filesEdited: ['src/a.ts'], check: { kind: 'vue-tsc' } }]);
  });

  it('no daemon: exits 0 silently and does NOT start one; stop_hook_active and garbage exit 0 at once', async () => {
    const repo = tmp('click-stopnodaemon-');
    mkdirSync(join(repo, '.click'));
    writeFileSync(join(repo, OPT_IN_FILE), '');
    const tPath = join(repo, 't.jsonl');
    writeFileSync(tPath, `${[prompt('go'), toolUse('Edit', { file_path: join(repo, 'src', 'a.ts') })].join('\n')}\n`);
    const marker = join(repo, 'started.txt');
    const fakeCli = join(repo, 'fake-click.js');
    writeFileSync(fakeCli, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`);
    process.env.CLICK_CLI = fakeCli;
    try {
      const r = await run(JSON.stringify({ session_id: 's', transcript_path: tPath, cwd: repo, hook_event_name: 'Stop' }), repo);
      expect(r).toMatchObject({ code: 0, stdout: '' });
      await new Promise((x) => setTimeout(x, 500));
      expect(existsSync(marker)).toBe(false); // the hook never spawns a daemon
    } finally {
      delete process.env.CLICK_CLI;
    }
    for (const input of ['', 'garbage', JSON.stringify({ stop_hook_active: true, session_id: 's', transcript_path: tPath, cwd: repo })]) {
      expect(await run(input, repo)).toMatchObject({ code: 0, stdout: '' });
    }
  });
});
