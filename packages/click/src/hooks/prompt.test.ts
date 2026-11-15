import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRoot, isOptedIn, OPT_IN_FILE, readHookConfig } from './hook-config.js';
import { gateRule, MAX_CONTEXT_CHARS, runPromptHook, type HookDeps } from './prompt.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'click-hook-'));
  mkdirSync(join(root, '.click'));
  writeFileSync(join(root, OPT_IN_FILE), ''); // the repo opted in
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const PROMPT = 'add a loading state to the checkout button while the order submits';
const payload = (over: Record<string, unknown> = {}) => JSON.stringify({ session_id: 's1', transcript_path: '/t.jsonl', cwd: root, hook_event_name: 'UserPromptSubmit', prompt: PROMPT, ...over });

type Call = { path: string; body: Record<string, unknown>; deadlineMs: number };
function fakeClient(answer: unknown, calls: Call[] = []): NonNullable<HookDeps['clientFor']> {
  return () => ({ tryRequest: async (path: string, o: { body?: unknown; deadlineMs: number }) => (calls.push({ path, body: o.body as Record<string, unknown>, deadlineMs: o.deadlineMs }), answer as never) });
}
const GOOD = { text: '<click_context version="1">…</click_context>', tokens: 321, degraded: [] };
const hookJson = (text: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });

describe('prompt hook (PROMPTS 116, SPEC §12.1)', () => {
  it('delivers the packed context in exactly the shape Claude Code expects, and asks the daemon the right thing', async () => {
    const calls: Call[] = [];
    const r = await runPromptHook(payload(), { clientFor: fakeClient(GOOD, calls), env: {} });
    expect(r).toEqual({ stdout: hookJson(GOOD.text), outcome: 'delivered' });
    expect(JSON.parse(r.stdout!)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: GOOD.text } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: '/context', body: { task: PROMPT, sessionId: 's1', source: 'hook', budgetTokens: 4000, maxChars: MAX_CONTEXT_CHARS } });
    expect(calls[0]!.deadlineMs).toBeLessThanOrEqual(1500);
    expect(calls[0]!.deadlineMs).toBeGreaterThan(1000);
  });

  describe('gating (print nothing)', () => {
    const silent = async (input: string, cfg?: unknown, calls: Call[] = []) => {
      if (cfg) writeFileSync(join(root, 'click.config.json'), JSON.stringify(cfg));
      const r = await runPromptHook(input, { clientFor: fakeClient(GOOD, calls), env: {} });
      expect(r.stdout).toBeNull();
      return { r, calls };
    };
    it('a prompt that starts with /', async () => {
      const { r, calls } = await silent(payload({ prompt: '/clear the context please now' }));
      expect(r.outcome).toBe('skip:slash-command');
      expect(calls).toHaveLength(0); // never even asks the daemon
    });
    it('#noclick anywhere, in any case', async () => {
      expect((await silent(payload({ prompt: `${PROMPT} #NoClick` }))).r.outcome).toBe('skip:noclick');
    });
    it('fewer than 4 words', async () => {
      expect((await silent(payload({ prompt: 'fix the bug' }))).r.outcome).toBe('skip:short');
      expect((await silent(payload({ prompt: '   ok   ' }))).r.outcome).toBe('skip:short');
      expect((await runPromptHook(payload({ prompt: 'fix the bug now' }), { clientFor: fakeClient(GOOD), env: {} })).outcome).toBe('delivered');
    });
    it('hook.mode off', async () => {
      expect((await silent(payload(), { hook: { mode: 'off' } })).r.outcome).toBe('skip:mode-off');
    });
    it('hook.mode first: the first prompt of a session gets context, later ones do not, other sessions still do', async () => {
      writeFileSync(join(root, 'click.config.json'), JSON.stringify({ hook: { mode: 'first' } }));
      const calls: Call[] = [];
      const deps = { clientFor: fakeClient(GOOD, calls), env: {} };
      expect((await runPromptHook(payload(), deps)).outcome).toBe('delivered');
      expect((await runPromptHook(payload(), deps)).outcome).toBe('skip:already-sent');
      expect((await runPromptHook(payload({ session_id: 'other' }), deps)).outcome).toBe('delivered');
      expect(calls).toHaveLength(2);
    });
    it('hook.mode first without a session id cannot remember: it keeps delivering', async () => {
      writeFileSync(join(root, 'click.config.json'), JSON.stringify({ hook: { mode: 'first' } }));
      const deps = { clientFor: fakeClient(GOOD), env: {} };
      expect((await runPromptHook(payload({ session_id: undefined }), deps)).outcome).toBe('delivered');
      expect((await runPromptHook(payload({ session_id: undefined }), deps)).outcome).toBe('delivered');
    });
    it('a different hook event', async () => {
      expect((await silent(payload({ hook_event_name: 'Stop' }))).r.outcome).toBe('skip:other-event');
    });
  });

  it('budget and mode come from click.config.json', async () => {
    writeFileSync(join(root, 'click.config.json'), JSON.stringify({ hook: { budgetTokens: 2500 } }));
    const calls: Call[] = [];
    await runPromptHook(payload(), { clientFor: fakeClient(GOOD, calls), env: {} });
    expect(calls[0]!.body.budgetTokens).toBe(2500);
  });

  it('prints nothing when there is no usable answer: no daemon, empty, warming, or too long for Claude Code', async () => {
    const run = (answer: unknown) => runPromptHook(payload(), { clientFor: fakeClient(answer), env: {} });
    expect(await run(null)).toEqual({ stdout: null, outcome: 'no-context:daemon' });
    expect((await run({ text: '', tokens: 0, degraded: ['warming'] })).outcome).toBe('no-context:warming');
    expect((await run({ text: '', tokens: 0, degraded: [] })).outcome).toBe('no-context:empty');
    expect((await run({ text: 5 })).stdout).toBeNull();
    expect(await run({ text: 'x'.repeat(10_001) })).toEqual({ stdout: null, outcome: 'no-context:too-long' });
    expect((await run({ text: 'x'.repeat(10_000) })).stdout).not.toBeNull();
  });

  it('survives garbage: bad JSON, wrong shapes, a client that throws', async () => {
    for (const raw of ['', 'not json', '{"prompt":5}', '[]', 'null', '"just a string"', '{}', '���']) {
      const r = await runPromptHook(raw, { clientFor: fakeClient(GOOD), env: {} });
      expect(r.stdout, raw).toBeNull();
    }
    const boom = await runPromptHook(payload(), { clientFor: () => ({ tryRequest: () => Promise.reject(new Error('kaboom')) }), env: {} });
    expect(boom).toEqual({ stdout: null, outcome: 'error:Error' });
    const thrower = await runPromptHook(payload(), { clientFor: () => { throw new TypeError('x'); }, env: {} });
    expect(thrower.stdout).toBeNull();
  });

  it('a 100 KB prompt is cut to 20,000 characters before it goes to the daemon', async () => {
    const calls: Call[] = [];
    await runPromptHook(payload({ prompt: `fix this please ${'x'.repeat(100_000)}` }), { clientFor: fakeClient(GOOD, calls), env: {} });
    expect((calls[0]!.body.task as string).length).toBe(20_000);
  });

  it('acts only in a repo that opted in, and finds it from a subfolder', async () => {
    const calls: Call[] = [];
    const bare = mkdtempSync(join(tmpdir(), 'click-bare-'));
    try {
      const r = await runPromptHook(payload({ cwd: bare }), { clientFor: fakeClient(GOOD, calls), env: {} });
      expect(r.outcome).toBe('skip:not-a-click-repo');
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
    const sub = join(root, 'src', 'components');
    mkdirSync(sub, { recursive: true });
    expect((await runPromptHook(payload({ cwd: sub }), { clientFor: fakeClient(GOOD, calls), env: {} })).outcome).toBe('delivered');
  });

  it('writes a log line with the outcome and timing, never the prompt', async () => {
    await runPromptHook(payload({ prompt: 'my secret password is hunter2 please refactor this' }), { clientFor: fakeClient(GOOD), env: {} });
    const dir = join(root, '.click', 'logs');
    const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
    const line = JSON.parse(text.trim().split('\n').at(-1)!) as Record<string, unknown>;
    expect(line).toMatchObject({ proc: 'hook', outcome: 'delivered', tokens: 321 });
    expect(typeof line.ms).toBe('number');
    expect(text).not.toContain('hunter2');
  });
});

describe('gateRule', () => {
  it('order of rules: mode off wins, then slash, #noclick, length, then first-mode memory', () => {
    expect(gateRule('/x a b c d', 'off', false)).toBe('mode-off');
    expect(gateRule('/x a b c d', 'always', false)).toBe('slash-command');
    expect(gateRule('a b c #noclick', 'always', false)).toBe('noclick');
    expect(gateRule('a b c', 'always', false)).toBe('short');
    expect(gateRule('a b c d', 'first', true)).toBe('already-sent');
    expect(gateRule('a b c d', 'first', false)).toBeNull();
    expect(gateRule('a b c d', 'always', true)).toBeNull();
  });
});

describe('opting in (a machine-wide ~/.click must not turn every folder below it into a Click repo)', () => {
  it('a home directory with a .click (token, caches) never opts anything in, and is never a repo itself', () => {
    const home = mkdtempSync(join(tmpdir(), 'click-home-'));
    try {
      mkdirSync(join(home, '.click'));
      writeFileSync(join(home, '.click', 'hydradb-token'), 'secret');
      const project = join(home, 'Documents', 'some-project', 'src');
      mkdirSync(project, { recursive: true });
      expect(findRoot(project, {}, home)).toBeNull();
      expect(isOptedIn(home, home)).toBe(false);
      writeFileSync(join(home, 'click.config.json'), '{}');
      writeFileSync(join(home, OPT_IN_FILE), '');
      expect(findRoot(project, {}, home)).toBeNull(); // not even with every marker: the home directory is not a repo
      expect(findRoot(project, { CLAUDE_PROJECT_DIR: home }, home)).toBeNull();
      // a real repo under the home directory still works
      writeFileSync(join(home, 'Documents', 'some-project', 'click.config.json'), '{}');
      expect(findRoot(project, {}, home)).toBe(join(home, 'Documents', 'some-project'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('every sign of a real Click repo counts: config file, marker, running daemon, an index', () => {
    const r = mkdtempSync(join(tmpdir(), 'click-signs-'));
    try {
      const home = join(r, 'h');
      expect(isOptedIn(r, home)).toBe(false);
      mkdirSync(join(r, '.click', 'graph'), { recursive: true });
      expect(isOptedIn(r, home)).toBe(false);
      writeFileSync(join(r, '.click', 'graph', 'CURRENT'), 'v1');
      expect(isOptedIn(r, home)).toBe(true);
      rmSync(join(r, '.click'), { recursive: true });
      writeFileSync(join(r, '.click.tmp'), '');
      writeFileSync(join(r, 'click.config.json'), '{}');
      expect(isOptedIn(r, home)).toBe(true);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});

describe('hook-config', () => {
  it('readHookConfig tolerates anything', () => {
    expect(readHookConfig(root)).toEqual({ mode: 'always', budgetTokens: 4000 });
    writeFileSync(join(root, 'click.config.json'), '{ broken');
    expect(readHookConfig(root)).toEqual({ mode: 'always', budgetTokens: 4000 });
    writeFileSync(join(root, 'click.config.json'), JSON.stringify({ hook: { mode: 'nonsense', budgetTokens: 'lots' } }));
    expect(readHookConfig(root)).toEqual({ mode: 'always', budgetTokens: 4000 });
    writeFileSync(join(root, 'click.config.json'), JSON.stringify({ hook: { mode: 'first', budgetTokens: 3000 } }));
    expect(readHookConfig(root)).toEqual({ mode: 'first', budgetTokens: 3000 });
  });

  it('findRoot prefers a running daemon, then CLAUDE_PROJECT_DIR, then the nearest opted-in ancestor', () => {
    const outer = mkdtempSync(join(tmpdir(), 'click-root-'));
    try {
      const inner = join(outer, 'a', 'b');
      mkdirSync(inner, { recursive: true });
      const home = join(outer, 'elsewhere-home'); // an isolated boundary: whatever the real home directory holds cannot leak in
      mkdirSync(home);
      expect(findRoot(inner, {}, home)).toBeNull();
      mkdirSync(join(outer, '.click'));
      expect(findRoot(inner, {}, home)).toBeNull(); // a bare .click is not an opt-in
      writeFileSync(join(outer, OPT_IN_FILE), '');
      expect(findRoot(inner, {}, home)).toBe(outer);
      mkdirSync(join(outer, 'a', '.click'));
      writeFileSync(join(outer, 'a', '.click', 'daemon.json'), '{}');
      expect(findRoot(inner, {}, home)).toBe(join(outer, 'a'));
      expect(findRoot(inner, { CLAUDE_PROJECT_DIR: outer }, home)).toBe(join(outer, 'a')); // a running daemon still wins
      rmSync(join(outer, 'a', '.click'), { recursive: true });
      expect(findRoot(inner, { CLAUDE_PROJECT_DIR: root }, home)).toBe(root);
      expect(existsSync(root)).toBe(true);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});
