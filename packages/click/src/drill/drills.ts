// PROMPTS 179 / SPEC §18.2: `pnpm drill`. The promise "Click never blocks the developer", tested with the real, bundled hook
// (dist/hooks/prompt.js) in a child process, exactly as Claude Code runs it. In every drill the hook must
//   - exit 0 (any other code is an error in Claude Code, and 2 would block the prompt),
//   - inside its 3 s timeout (wall clock, node start-up included),
//   - print nothing, or one JSON object whose additionalContext is a string under 10,000 characters.
// Some drills also assert that the system recovers (a corrupt snapshot is rebuilt) or degrades honestly (the answer says
// "graph-replica" when HydraDB cannot be used). A drill that cannot be run on this machine is reported as SKIPPED with the
// reason, never as passed.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..', '..', '..', '..');
const FIXTURE = join(ROOT, 'packages', 'core', 'test', 'fixtures', 'mini-vue');
const DIST = join(ROOT, 'packages', 'click', 'dist');
export const HOOK_TIMEOUT_MS = 3_000;
const MAX_CONTEXT_CHARS = 10_000;
const TASK = 'when a user logs out, clear the session state and the open tabs';

export interface HookRun {
  exitCode: number | null;
  ms: number;
  stdout: string;
  stderr: string;
}
export type DrillStatus = 'pass' | 'fail' | 'skip';
export interface DrillResult {
  n: number;
  name: string;
  status: DrillStatus;
  detail: string;
  hookMs?: number;
}

/** What a valid hook answer is: nothing at all, or one JSON object carrying the context. Pure, so it is tested on its own. */
export function judgeHookRun(run: HookRun, timeoutMs = HOOK_TIMEOUT_MS): { ok: boolean; why: string } {
  if (run.exitCode !== 0) return { ok: false, why: `exit code ${String(run.exitCode)} (Claude Code treats anything but 0 as an error)` };
  if (run.ms > timeoutMs) return { ok: false, why: `took ${run.ms} ms, over the ${timeoutMs} ms hook timeout` };
  const out = run.stdout.trim();
  if (!out) return { ok: true, why: 'empty output' };
  try {
    const j = JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: unknown } };
    const ctx = j.hookSpecificOutput?.additionalContext;
    if (typeof ctx !== 'string') return { ok: false, why: 'JSON without hookSpecificOutput.additionalContext' };
    if (ctx.length > MAX_CONTEXT_CHARS) return { ok: false, why: `context is ${ctx.length} characters (Claude Code truncates above ${MAX_CONTEXT_CHARS})` };
    return { ok: true, why: `${ctx.length} characters of context` };
  } catch {
    return { ok: false, why: 'stdout is not valid JSON' };
  }
}

// ------------------------------------------------------------------ plumbing

const tmpRepos: string[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];

function makeRepo(opts: { git?: boolean; optIn?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'click-drill-'));
  tmpRepos.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  if (opts.git !== false) {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['-c', 'user.email=d@d', '-c', 'user.name=d', 'add', '-A'], { cwd: dir });
    spawnSync('git', ['-c', 'user.email=d@d', '-c', 'user.name=d', 'commit', '-q', '-m', 'init'], { cwd: dir });
  }
  if (opts.optIn !== false) {
    mkdirSync(join(dir, '.click'), { recursive: true });
    writeFileSync(join(dir, '.click', 'enabled'), '');
  }
  return dir;
}

const cli = (repo: string, args: string[], env: NodeJS.ProcessEnv = {}, timeout = 120_000) =>
  spawnSync(process.execPath, [join(DIST, 'click.js'), ...args, '--root', repo], { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env }, timeout });

/** Run the real hook the way Claude Code does: a JSON payload on stdin, cwd = the repository. */
export function runHook(repo: string, stdin: string | Buffer, env: NodeJS.ProcessEnv = {}): Promise<HookRun> {
  return new Promise((done) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [join(DIST, 'hooks', 'prompt.js')], { cwd: repo, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const kill = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.on('close', (code) => {
      clearTimeout(kill);
      done({ exitCode: code, ms: Date.now() - t0, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
  });
}

const payload = (repo: string, prompt = TASK): string => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'drill', cwd: repo, prompt });

async function startDaemon(repo: string, env: NodeJS.ProcessEnv = {}): Promise<number | null> {
  const child = spawn(process.execPath, [join(DIST, 'click.js'), 'serve', '--root', repo], { cwd: repo, env: { ...process.env, ...env }, stdio: 'ignore', detached: true });
  child.unref();
  children.push(child);
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const d = JSON.parse(readFileSync(join(repo, '.click', 'daemon.json'), 'utf8')) as { port: number };
      const res = await fetch(`http://127.0.0.1:${d.port}/health`, { headers: { 'x-click-token': (JSON.parse(readFileSync(join(repo, '.click', 'daemon.json'), 'utf8')) as { token: string }).token }, signal: AbortSignal.timeout(500) }).catch(() => null);
      if (res?.ok) return child.pid ?? null;
    } catch {
      // not up yet
    }
  }
  return child.pid ?? null;
}

function stopAll(): void {
  for (const c of children) if (c.pid) spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
  children.length = 0;
  for (const s of servers) s.close();
  servers.length = 0;
}

/** Overwrite every file under a directory with garbage. */
function corrupt(dir: string): void {
  for (const f of readdirSync(dir, { recursive: true })) {
    const q = join(dir, String(f));
    if (statSync(q).isFile()) writeFileSync(q, '{ this is not a snapshot');
  }
}

const listen = (handler: Parameters<typeof createServer>[1]): Promise<{ port: number }> =>
  new Promise((ok) => {
    const s = createServer(handler);
    servers.push(s);
    s.listen(0, '127.0.0.1', () => ok({ port: (s.address() as { port: number }).port }));
  });

// ------------------------------------------------------------------ the drills

interface Drill {
  name: string;
  run: () => Promise<{ run?: HookRun; extra?: { ok: boolean; why: string }; skip?: string }>;
}

export const DRILLS: Drill[] = [
  {
    name: 'daemon not running',
    async run() {
      const repo = makeRepo();
      return { run: await runHook(repo, payload(repo)) };
    },
  },
  {
    name: 'daemon hung (answers /health, never answers /context)',
    async run() {
      const repo = makeRepo();
      const { port } = await listen((req, res) => {
        if (req.url?.startsWith('/health')) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, version: '0.1.0', ready: true }));
        }
        // every other route sleeps forever
      });
      writeFileSync(join(repo, '.click', 'daemon.json'), JSON.stringify({ v: 1, pid: process.pid, port, token: 'x'.repeat(32), startedAt: new Date().toISOString(), version: '0.1.0', root: repo }));
      return { run: await runHook(repo, payload(repo)) };
    },
  },
  {
    name: 'corrupt snapshot (the daemon rebuilds the graph and answers)',
    async run() {
      const repo = makeRepo();
      cli(repo, ['index']);
      const graph = join(repo, '.click', 'graph');
      if (!existsSync(graph)) return { skip: 'no snapshot was written, so there is nothing to corrupt' };
      corrupt(graph);
      await startDaemon(repo);
      const run = await runHook(repo, payload(repo));
      const out = cli(repo, ['context', TASK, '--budget', '2000']);
      const recovered = out.status === 0 && out.stdout.includes('<click_context');
      return { run, extra: { ok: recovered, why: recovered ? 'the daemon rebuilt the graph and answered' : `no recovery: ${(out.stderr || out.stdout).trim().split('\n').pop()}` } };
    },
  },
  {
    name: 'no network (HydraDB unreachable, no embeddings): answers from the local replica',
    async run() {
      const repo = makeRepo();
      cli(repo, ['index']);
      await startDaemon(repo, { HYDRADB_URL: 'http://127.0.0.1:9', HYDRADB_TOKEN: 'drill', OPENAI_API_KEY: '' });
      const run = await runHook(repo, payload(repo));
      const out = cli(repo, ['context', TASK, '--budget', '2000', '--json'], { HYDRADB_URL: 'http://127.0.0.1:9' });
      const degraded = /graph-replica|semantic-off/.test(out.stdout);
      return { run, extra: { ok: out.status === 0 && degraded, why: degraded ? 'answered, and said which part degraded' : 'no answer, or it did not say it degraded' } };
    },
  },
  {
    name: 'bad HydraDB key (every call is a 401)',
    async run() {
      const repo = makeRepo();
      cli(repo, ['index']);
      const { port } = await listen((_req, res) => {
        res.statusCode = 401;
        res.end('{"error":{"message":"invalid token"}}');
      });
      await startDaemon(repo, { HYDRADB_URL: `http://127.0.0.1:${port}`, HYDRADB_TOKEN: 'wrong' });
      const run = await runHook(repo, payload(repo));
      const out = cli(repo, ['context', TASK, '--budget', '2000', '--json']);
      return { run, extra: { ok: out.status === 0 && out.stdout.includes('"items"'), why: out.status === 0 ? 'the daemon answered from its replica' : 'the daemon did not answer' } };
    },
  },
  {
    name: 'Jev returning 429 repeatedly',
    async run() {
      return { skip: 'the delivery preset has no pruner (prune chain is ["none"]), so no request ever calls Jev; the prune fallback chain is covered by unit tests (packages/core/src/prune/chain.test.ts)' };
    },
  },
  {
    name: '100 KB prompt',
    async run() {
      const repo = makeRepo();
      cli(repo, ['index']);
      await startDaemon(repo);
      return { run: await runHook(repo, payload(repo, 'x '.repeat(50_000) + TASK)) };
    },
  },
  {
    name: 'non-UTF-8 stdin',
    async run() {
      const repo = makeRepo();
      return { run: await runHook(repo, Buffer.from([0xff, 0xfe, 0xfd, 0x7b, 0x22, 0xc3, 0x28, 0xa0, 0xa1])) };
    },
  },
  {
    name: 'repository that is not a git repo',
    async run() {
      const repo = makeRepo({ git: false });
      cli(repo, ['index']);
      await startDaemon(repo);
      return { run: await runHook(repo, payload(repo)) };
    },
  },
  {
    name: '.click/ not writable (it is a file where the directory should be)',
    async run() {
      const repo = makeRepo({ optIn: false });
      rmSync(join(repo, '.click'), { recursive: true, force: true });
      writeFileSync(join(repo, '.click'), 'not a directory');
      return { run: await runHook(repo, payload(repo)) };
    },
  },
];

export async function runDrills(only?: number[]): Promise<DrillResult[]> {
  if (!existsSync(join(DIST, 'hooks', 'prompt.js')) || !existsSync(join(DIST, 'click.js'))) throw new Error('dist is not built: run `pnpm build` first');
  const results: DrillResult[] = [];
  for (const [i, d] of DRILLS.entries()) {
    const n = i + 1;
    if (only && !only.includes(n)) continue;
    try {
      const r = await d.run();
      if (r.skip) results.push({ n, name: d.name, status: 'skip', detail: r.skip });
      else {
        const hook = r.run ? judgeHookRun(r.run) : { ok: true, why: '' };
        const ok = hook.ok && (r.extra ? r.extra.ok : true);
        results.push({ n, name: d.name, status: ok ? 'pass' : 'fail', detail: [r.run ? `hook: ${hook.why} (${r.run.ms} ms)` : '', r.extra?.why ?? ''].filter(Boolean).join(' · '), ...(r.run ? { hookMs: r.run.ms } : {}) });
      }
    } catch (e) {
      results.push({ n, name: d.name, status: 'fail', detail: `the drill itself threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      stopAll();
    }
  }
  for (const d of tmpRepos.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // a daemon that is still shutting down can hold the directory on Windows; the OS temp cleaner takes it later
    }
  }
  return results;
}
