// `pnpm demo`: get this machine ready to show Click working, and check every part with a green or red line.
//   1. Docker + the self-hosted HydraDB (started if it is not up)
//   2. the built Click CLI
//   3. the demo repository indexed and its graph in HydraDB
//   4. the Claude Code hook installed in it
//   5. one real request through the daemon: it must answer from HydraDB (not the local fallback) inside the budget
// It prints what to say and run next. It never prints secrets (the HydraDB token path is shown, never its contents).
//
//   DEMO_REPO=<path>   the repository to demo (default: the benchmark repo, bench/repo of the main checkout)
//   DEMO_TASK="..."    the task to ask (default: the logout example the dashboard shows)

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const worktree = resolve(here, '..');
const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: worktree, encoding: 'utf8' });
const mainRoot = git.status === 0 ? dirname(git.stdout.trim()) : worktree;
const repo = resolve(process.env.DEMO_REPO ?? join(mainRoot, 'bench', 'repo'));
const task = process.env.DEMO_TASK ?? 'When a user logs out, clear every piece of session state, remove open and cached tabs, reset access-controlled navigation, and then return them to the sign-in screen.';
const cli = join(worktree, 'packages', 'click', 'dist', 'click.js');
const tokenFile = [join(mainRoot, '.click', 'hydradb-token'), join(homedir(), '.click', 'hydradb-token')].find((p) => existsSync(p));
const env = { ...process.env, ...(tokenFile ? { HYDRADB_TOKEN_FILE: tokenFile } : {}), MSYS_NO_PATHCONV: '1' };

let failed = 0;
const ok = (msg: string): void => console.log(`  ✅ ${msg}`);
const bad = (msg: string, fix?: string): void => {
  failed++;
  console.log(`  ❌ ${msg}${fix ? `\n     → ${fix}` : ''}`);
};
const run = (cmd: string, args: string[], cwd = worktree, timeout = 120_000) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout, shell: process.platform === 'win32' && cmd === 'pnpm' });
const click = (args: string[], timeout?: number) => run(process.execPath, [cli, ...args, '--root', repo], worktree, timeout);

async function hydraReady(): Promise<boolean> {
  try {
    return (await fetch('http://127.0.0.1:9090/readyz', { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log(`\nClick demo check · repo: ${repo}\n`);

  console.log('1. HydraDB (the graph database)');
  if (!existsSync(repo)) bad(`the demo repo is not there: ${repo}`, 'run it in the main checkout, or set DEMO_REPO');
  const docker = run('docker', ['info', '--format', '{{.ServerVersion}}'], worktree, 20_000);
  if (docker.status !== 0) bad('Docker is not running', 'open Docker Desktop, wait until it says "running", then run this again');
  else {
    if (!(await hydraReady())) {
      console.log('  … starting HydraDB (docker compose, up to 30 s)');
      run('pnpm', ['hydra:up'], worktree, 180_000);
    }
    if (await hydraReady()) ok('HydraDB is up (http://127.0.0.1:9090/readyz answers 200)');
    else bad('HydraDB did not become ready', 'pnpm hydra:logs shows why');
  }
  if (tokenFile) ok(`token file found (${tokenFile})`);
  else bad('no HydraDB token file', 'pnpm hydra:up creates .click/hydradb-token');

  console.log('\n2. Click CLI');
  if (!existsSync(cli)) {
    console.log('  … building (pnpm build)');
    run('pnpm', ['build'], worktree, 240_000);
  }
  const ver = existsSync(cli) ? run(process.execPath, [cli, '--version']) : null;
  if (ver?.status === 0) ok(`click ${ver.stdout.trim()}`);
  else return void bad('the Click CLI is not built', 'pnpm build');

  console.log('\n3. The code graph');
  const idx = click(['index'], 180_000);
  const idxLine = idx.stdout.split('\n').find((l) => l.includes('nodes'));
  if (idx.status === 0) ok(idxLine ? idxLine.replace(/^Indexed /, 'indexed ') : 'the daemon is running and keeps the graph current');
  else bad('indexing failed', (idx.stderr || idx.stdout).trim().split('\n').pop());
  const push = click(['push'], 240_000);
  const pushed = existsSync(join(repo, '.click', 'lastPushedVersion')) ? readFileSync(join(repo, '.click', 'lastPushedVersion'), 'utf8').trim() : '';
  if (push.status === 0) ok('graph pushed to HydraDB');
  else if (pushed && /idempotency/.test(push.stderr)) ok(`graph already in HydraDB (version ${pushed}); the second push is refused by HydraDB, which is fine`);
  else bad('could not push the graph to HydraDB', (push.stderr || push.stdout).trim().split('\n').pop());

  console.log('\n4. Claude Code hook');
  let hooks = click(['hooks', 'status']);
  if (!/UserPromptSubmit/.test(hooks.stdout)) {
    click(['hooks', 'install', '--local']);
    hooks = click(['hooks', 'status']);
  }
  if (/UserPromptSubmit/.test(hooks.stdout)) ok('the prompt hook is installed in this repo');
  else bad('the hook is not installed', `click hooks install --local --root ${repo}`);

  console.log('\n5. One real request');
  // a daemon that has just started answers its first HydraDB queries cold (300-400 ms, around the deadline); a real session keeps
  // it running for hours, so warm it the way use would before measuring
  for (let i = 0; i < 2; i++) click(['context', 'warm up the graph', '--budget', '1000', '--json'], 60_000);
  const t0 = Date.now();
  const res = click(['context', task, '--budget', '4000', '--json'], 90_000);
  const ms = Date.now() - t0;
  try {
    const out = JSON.parse(res.stdout) as { tokens: number; budget: number; items: { path: string | null; mode: string }[]; degraded: string[]; timings?: Record<string, number> };
    const files = new Set(out.items.filter((i) => i.mode === 'body' || i.mode === 'file').map((i) => i.path));
    if (out.tokens > 0 && out.tokens <= out.budget) ok(`${out.tokens} tokens (budget ${out.budget}), ${out.items.length} items from ${files.size} files, ${out.timings?.total ?? ms} ms`);
    else bad(`unexpected size: ${out.tokens} tokens for a budget of ${out.budget}`);
    if (out.degraded.includes('graph-replica')) bad('the graph came from the local copy, not HydraDB', 'check step 1, then run this again');
    else ok('the graph walk was answered by HydraDB (no "graph-replica" flag)');
    if (out.degraded.length) console.log(`     flags: ${out.degraded.join(', ')} (semantic-off just means no OpenAI key, which is fine)`);
  } catch {
    bad('the request failed', (res.stderr || res.stdout).trim().split('\n').pop());
  }
  const st = click(['status']);
  const stLine = st.stdout.split('\n').find((l) => l.startsWith('hydradb'));
  if (stLine) (stLine.includes('ok') ? ok : (m: string) => bad(m))(stLine.trim());

  console.log(failed ? `\n${failed} problem(s) above. Fix them, then run \`pnpm demo\` again.\n` : '\nEverything is ready. What to show:\n');
  if (!failed) {
    console.log('  Terminal (this repo):');
    console.log(`    node packages/click/dist/click.js status --root "${repo}"`);
    console.log(`    node packages/click/dist/click.js map --stats --root "${repo}"`);
    console.log(`    node packages/click/dist/click.js context "<your task>" --root "${repo}" --budget 4000`);
    console.log('  Claude Code: open the demo repo in VS Code (or run `claude` in it) and paste this prompt:');
    console.log(`    ${task}`);
    console.log(`  Proof the hook fired: a new "delivered" line in ${join(repo, '.click', 'logs')}\n`);
  }
  process.exitCode = failed ? 1 : 0;
}

void main();
