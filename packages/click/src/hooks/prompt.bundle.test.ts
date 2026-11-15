// The real thing: esbuild the hook, run it as a separate node process the way Claude Code does, and measure it.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bundle } from '../build/bundle.js';
import { writeInfo } from '../daemon/lifecycle.js';
import { startHttp, type HttpHandle, type Route } from '../daemon/server.js';

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
  out = tmp('click-bundle-');
  await bundle({ outdir: out, hooksOnly: true });
  hook = join(out, 'hooks', 'prompt.js');
}, 60_000);
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
});
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}
function runHook(stdin: string | Buffer, cwd: string, env: Record<string, string> = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [hook], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: performance.now() - t0 }));
    child.stdin.on('error', () => undefined); // the hook may exit before reading everything
    child.stdin.end(stdin);
  });
}

const PROMPT = 'add a loading state to the checkout button while the order submits';
const payload = (cwd: string, over: Record<string, unknown> = {}) => JSON.stringify({ session_id: 's1', transcript_path: '/t', cwd, hook_event_name: 'UserPromptSubmit', prompt: PROMPT, ...over });

async function repoWithDaemon(routes: Route[]): Promise<string> {
  const root = tmp('click-hook-repo-');
  mkdirSync(join(root, '.click'));
  const h = await startHttp({
    token: 'tok',
    routes: [{ method: 'GET', path: '/health', handle: () => ({ ok: true, status: 'ready', version: '0', graphVersion: 'g', nodes: 1, edges: 1 }) }, ...routes],
  });
  handles.push(h);
  await writeInfo(join(root, '.click'), { v: 1, pid: process.pid, port: h.port, token: 'tok', startedAt: '2026-11-15T10:00:00.000Z', version: '0', root });
  return root;
}
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('dist/hooks/prompt.js as a real process (PROMPTS 116)', () => {
  it('is small and dependency-free', () => {
    expect(statSync(hook).size).toBeLessThan(30_000);
    const code = readFileSync(hook, 'utf8');
    expect(code).not.toMatch(/from\s*["']zod["']/);
    expect(code).not.toMatch(/typescript|compiler-sfc|openai/);
  });

  it('cold start: `node prompt.js < payload.json` takes < 100 ms (median of 9, nothing to do)', async () => {
    const bare = tmp('click-bare-'); // not a click repo: the hook does its start-up and exits
    await runHook(payload(bare), bare); // warm the disk cache; the budget is about steady cold starts
    const times: number[] = [];
    for (let i = 0; i < 9; i++) {
      const r = await runHook(payload(bare), bare);
      expect(r).toMatchObject({ code: 0, stdout: '' });
      times.push(r.ms);
    }
    process.stdout.write(`hook cold start: median ${median(times).toFixed(0)} ms, max ${Math.max(...times).toFixed(0)} ms\n`);
    expect(median(times)).toBeLessThan(100);
  }, 60_000);

  it('delivers context from a live daemon in the exact stdout format, exit 0, quickly', async () => {
    const seen: Record<string, unknown>[] = [];
    const root = await repoWithDaemon([{ method: 'POST', path: '/context', handle: ({ body }) => (seen.push(body as Record<string, unknown>), { text: '<click_context version="1">CheckoutButton…</click_context>', tokens: 44, degraded: [] }) }]);
    const r = await runHook(payload(root), root);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '<click_context version="1">CheckoutButton…</click_context>' } });
    expect(seen[0]).toMatchObject({ task: PROMPT, sessionId: 's1', source: 'hook', maxChars: 9800 });
    expect(r.ms).toBeLessThan(1_000);
  });

  it('each gating rule prints nothing and exits 0', async () => {
    const root = await repoWithDaemon([{ method: 'POST', path: '/context', handle: () => ({ text: 'SHOULD NOT BE USED', tokens: 1, degraded: [] }) }]);
    for (const prompt of ['/compact now please thanks', `${PROMPT} #noclick`, 'fix it']) {
      const r = await runHook(payload(root, { prompt }), root);
      expect(r, prompt).toMatchObject({ code: 0, stdout: '' });
    }
  });

  it('no daemon: prints nothing, exits 0 quickly, and starts one in the background', async () => {
    const root = tmp('click-nodaemon-');
    mkdirSync(join(root, '.click'));
    const marker = join(root, 'started.txt');
    const fakeCli = join(root, 'fake-click.js');
    writeFileSync(fakeCli, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));`);
    const r = await runHook(payload(root), root, { CLICK_CLI: fakeCli });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(1_000);
    const end = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < end) await new Promise((x) => setTimeout(x, 50));
    expect(readFileSync(marker, 'utf8')).toBe(`serve --root ${root}`);
  });

  it('a hung daemon cannot hold the agent: exits 0 with nothing printed within the 1.5 s deadline', async () => {
    const root = await repoWithDaemon([{ method: 'POST', path: '/context', handle: () => new Promise(() => undefined) }]);
    const r = await runHook(payload(root), root);
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeGreaterThan(1_000);
    expect(r.ms).toBeLessThan(2_300);
  }, 20_000);

  it('a daemon that errors, or answers with nonsense, gives nothing', async () => {
    const root = await repoWithDaemon([{ method: 'POST', path: '/context', handle: () => Promise.reject(new Error('boom')) }]);
    expect(await runHook(payload(root), root)).toMatchObject({ code: 0, stdout: '' });
    const root2 = await repoWithDaemon([{ method: 'POST', path: '/context', handle: () => ({ text: 12345 }) }]);
    expect(await runHook(payload(root2), root2)).toMatchObject({ code: 0, stdout: '' });
  });

  it('bad input never matters: empty stdin, garbage, non-UTF-8 bytes, 100 KB prompt, 4 MB of noise', async () => {
    const root = await repoWithDaemon([{ method: 'POST', path: '/context', handle: ({ body }) => ({ text: `got ${(body as { task: string }).task.length} chars`, tokens: 1, degraded: [] }) }]);
    for (const input of ['', 'garbage', '{"prompt":', Buffer.from([0xff, 0xfe, 0x80, 0x81, 0x00, 0xc3, 0x28])]) {
      expect(await runHook(input, root), String(input).slice(0, 20)).toMatchObject({ code: 0, stdout: '' });
    }
    const big = await runHook(payload(root, { prompt: `please refactor this module ${'x'.repeat(100_000)}` }), root);
    expect(big.code).toBe(0);
    expect(JSON.parse(big.stdout).hookSpecificOutput.additionalContext).toBe('got 20000 chars');
    const noise = await runHook(Buffer.alloc(4_500_000, 'a'), root);
    expect(noise).toMatchObject({ code: 0, stdout: '' });
    expect(noise.ms).toBeLessThan(3_000);
    const nonUtf8Prompt = Buffer.concat([Buffer.from(payload(root, { prompt: 'PLACEHOLDER' }).replace('PLACEHOLDER', 'refactor the café module for the checkout flow now')), Buffer.from([0xff])]);
    expect(await runHook(nonUtf8Prompt, root)).toMatchObject({ code: 0 }); // trailing garbage: JSON.parse fails → nothing, but no crash
  }, 60_000);

  it('works when stdin is closed immediately and the cwd does not exist', async () => {
    expect(await runHook('', tmp('click-x-'))).toMatchObject({ code: 0, stdout: '' });
    const r = await runHook(payload(join(tmpdir(), 'definitely', 'not', 'there')), tmp('click-y-'));
    expect(r).toMatchObject({ code: 0, stdout: '' });
  });
});
