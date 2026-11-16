// PROMPTS 190-192: the end-to-end harness. Does a coding agent that gets Click's context solve real tasks with fewer tokens
// than the same agent without it?
//
// For each (task, variant):
//   1. a git worktree of the benchmark repo at the task's PARENT commit (the code before the real change was made)
//   2. variant V0 = the agent as it is; "delivery" / "V1" = Click installed (index, daemon, prompt hook), with that preset pinned
//   3. Claude Code headless on the task text, with a hard wall-clock cap and a spend cap
//   4. the task's check (vue-tsc must not get worse, and the task's vitest file must pass) decides "solved"
//   5. tokens are read from the agent's own JSON: input, output, cache read and cache creation stay separate
// Rows go to docs/e2e/<runId>.jsonl and a summary to docs/e2e/<runId>.json; the dashboard exporter turns them into e2e rows.
// A real run spends API budget (each agent run is a real Claude session): the defaults are small and every run is capped.
//
//   pnpm e2e --tasks 3 --variants V0,delivery [--model <id>] [--max-usd 1.5] [--timeout-min 10] [--dry]
//   --dry runs the whole pipeline (worktree, index, check, cleanup) with a no-op agent: it costs nothing and proves the plumbing.

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const worktreeRoot = resolve(here, '..', '..', '..', '..');

export interface E2eTask {
  id: string;
  text: string;
  parentCommit: string;
  checkTests: string[];
}
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}
/** What the agent did, from the stream: how it explored before it started editing. */
export interface AgentTrace {
  /** tool name -> number of calls */
  toolCalls: Record<string, number>;
  /** Read + Grep + Glob calls */
  exploreCalls: number;
  /** distinct file paths the agent opened with Read */
  filesRead: number;
  /** the assistant turn (1-based) of the first Edit/Write/MultiEdit, null if it never edited */
  turnsBeforeFirstEdit: number | null;
}
export interface AgentResult {
  trace?: AgentTrace;
  usage: AgentUsage;
  turns: number;
  costUsd: number;
  isError: boolean;
  timedOut: boolean;
  wallMs: number;
}
export interface E2eRow extends AgentResult {
  runId: string;
  taskId: string;
  variant: string;
  solved: boolean;
  tscErrorsBefore: number;
  tscErrorsAfter: number;
  testPassed: boolean;
  /** The check could not run (see isGraderError): the row is kept for the record but counts in no summary. */
  gradeError?: boolean;
  note?: string;
}
export interface VariantSummary {
  variant: string;
  n: number;
  solved: number;
  solveRate: number;
  /** Tokens spent per solved task: input + output + cache creation of ALL runs (solved or not) divided by solved runs. Cache reads are reported on their own. */
  tokensPerSolved: number | null;
  cacheReadPerSolved: number | null;
  turnsPerSolved: number | null;
  wallSecPerSolved: number | null;
  costUsdPerSolved: number | null;
  /** Over ALL runs of the variant: mean Read+Grep+Glob calls, and mean assistant turn of the first edit (runs that edited), when the stream was traced. */
  exploreCallsMean: number | null;
  turnsBeforeFirstEditMean: number | null;
}

// ------------------------------------------------------------------ pure parts (tested)

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The JSON `claude -p --output-format json` prints. Missing fields count as 0; a non-JSON answer is an error result. */
export function parseClaudeJson(stdout: string): Omit<AgentResult, 'wallMs' | 'timedOut'> {
  const empty = { usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, turns: 0, costUsd: 0, isError: true };
  let j: Record<string, unknown>;
  try {
    const text = stdout.trim();
    const parsed = JSON.parse(text.slice(text.indexOf('{'))) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return empty;
    j = parsed as Record<string, unknown>;
  } catch {
    return empty;
  }
  const u = (j.usage ?? {}) as Record<string, unknown>;
  return {
    usage: { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheCreation: num(u.cache_creation_input_tokens) },
    turns: num(j.num_turns),
    costUsd: num(j.total_cost_usd),
    isError: j.is_error === true,
  };
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob']);

/** `claude -p --output-format stream-json --verbose`: one JSON object per line. The last "result" line has the usage; the assistant lines have the tool calls. A plain single-JSON answer still parses (without a trace). */
export function parseClaudeStream(stdout: string): Omit<AgentResult, 'wallMs' | 'timedOut'> {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const e = JSON.parse(t) as unknown;
      if (typeof e === 'object' && e !== null) events.push(e as Record<string, unknown>);
    } catch {
      // a partial line (the run was killed): skip it
    }
  }
  const result = [...events].reverse().find((e) => e.type === 'result');
  if (!result) return parseClaudeJson(stdout);
  const base = parseClaudeJson(JSON.stringify(result));
  const toolCalls: Record<string, number> = {};
  const files = new Set<string>();
  const turnIds: string[] = [];
  let firstEdit: number | null = null;
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    const message = (e.message ?? {}) as { id?: unknown; content?: unknown };
    const id = typeof message.id === 'string' ? message.id : `#${turnIds.length}`;
    if (!turnIds.includes(id)) turnIds.push(id);
    const turn = turnIds.indexOf(id) + 1;
    for (const block of Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : []) {
      if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
      toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
      const input = (block.input ?? {}) as Record<string, unknown>;
      if (block.name === 'Read' && typeof input.file_path === 'string') files.add(input.file_path);
      if (EDIT_TOOLS.has(block.name) && firstEdit === null) firstEdit = turn;
    }
  }
  if (turnIds.length === 0) return base; // no assistant lines: not a traced stream, so no trace (an empty one would read as "did nothing")
  const exploreCalls = Object.entries(toolCalls).filter(([n]) => EXPLORE_TOOLS.has(n)).reduce((a, [, c]) => a + c, 0);
  return { ...base, trace: { toolCalls, exploreCalls, filesRead: files.size, turnsBeforeFirstEdit: firstEdit } };
}

export const countTscErrors = (output: string): number => output.split('\n').filter((l) => /error TS\d+/.test(l)).length;

/** A task is solved when the type-check got no worse and the task's own test passes. */
export const isSolved = (before: number, after: number, testPassed: boolean): boolean => testPassed && after <= before;

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function summarise(rows: readonly E2eRow[]): VariantSummary[] {
  const variants = [...new Set(rows.map((r) => r.variant))];
  return variants.map((variant) => {
    const mine = rows.filter((r) => r.variant === variant && !r.gradeError);
    const solved = mine.filter((r) => r.solved);
    const spent = mine.reduce((s, r) => s + r.usage.input + r.usage.output + r.usage.cacheCreation, 0);
    const per = (f: (r: E2eRow) => number): number | null => (solved.length ? mine.reduce((s, r) => s + f(r), 0) / solved.length : null);
    return {
      variant,
      n: mine.length,
      solved: solved.length,
      solveRate: mine.length ? solved.length / mine.length : 0,
      tokensPerSolved: solved.length ? spent / solved.length : null,
      cacheReadPerSolved: per((r) => r.usage.cacheRead),
      turnsPerSolved: per((r) => r.turns),
      wallSecPerSolved: per((r) => r.wallMs / 1000),
      costUsdPerSolved: per((r) => r.costUsd),
      exploreCallsMean: mean(mine.flatMap((r) => (r.trace ? [r.trace.exploreCalls] : []))),
      turnsBeforeFirstEditMean: mean(mine.flatMap((r) => (r.trace?.turnsBeforeFirstEdit != null ? [r.trace.turnsBeforeFirstEdit] : []))),
    };
  });
}

export { mean };

// ------------------------------------------------------------------ the real work

export interface HarnessDeps {
  /** Run the coding agent in `cwd` on `prompt`. */
  agent: (cwd: string, prompt: string) => Promise<AgentResult>;
  /** Make Click available in `cwd` for this variant (index, hook, daemon). Absent for V0. */
  setupClick?: (cwd: string, variant: string) => void;
  teardownClick?: (cwd: string) => void;
  /** Where to keep, per run, what the agent changed (.diff) and the check's output (.test.txt). */
  artifactDir?: string;
}

interface Paths {
  mainRoot: string;
  repo: string;
  cli: string;
}
export function resolvePaths(): Paths {
  const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: worktreeRoot, encoding: 'utf8' });
  const mainRoot = git.status === 0 ? dirname(git.stdout.trim()) : worktreeRoot;
  return { mainRoot, repo: process.env.E2E_REPO ?? join(mainRoot, 'bench', 'repo'), cli: join(worktreeRoot, 'packages', 'click', 'dist', 'click.js') };
}

export function loadTasks(mainRoot: string, limit: number, only?: readonly string[]): E2eTask[] {
  const dir = join(mainRoot, 'bench', 'tasks', 'mined');
  const out: E2eTask[] = [];
  for (const f of readdirSafe(join(mainRoot, 'bench', 'e2e', 'checks'))) {
    const id = f.replace(/\.test\.ts$/, '');
    if (only?.length && !only.includes(id)) continue;
    const file = join(dir, `${id}.json`);
    if (!existsSync(file)) continue;
    const t = JSON.parse(readFileSync(file, 'utf8')) as { text: string; parentCommit: string };
    out.push({ id, text: t.text, parentCommit: t.parentCommit, checkTests: [join(mainRoot, 'bench', 'e2e', 'checks', f)] });
  }
  return out.slice(0, limit);
}
function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.test.ts'));
  } catch {
    return [];
  }
}

const sh = (cmd: string, args: string[], cwd: string, timeoutMs = 600_000) => spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, shell: process.platform === 'win32' && cmd !== process.execPath, maxBuffer: 64 * 1024 * 1024 });

/**
 * The tasks start from different commits, and the vite/vitest config of an older commit imports plugins the pinned install does not
 * have (@vitejs/plugin-vue-jsx, vite-plugin-vue-mcp, vite-plugin-svg-icons, jsdom). Without them vitest dies at startup and the
 * task reads as unsolved whatever the agent did. They are installed once into repo/node_modules/.e2e-extra and linked next to the
 * pinned ones (node_modules is ignored by the index, and the repo's package.json stays untouched).
 */
export const GRADER_DEPS: { install: string; link: string }[] = [
  { install: '@vitejs/plugin-vue-jsx@5.1.6', link: '@vitejs/plugin-vue-jsx' },
  { install: 'vite-plugin-vue-mcp@0.3.2', link: 'vite-plugin-vue-mcp' },
  { install: 'vite-plugin-svg-icons@2.0.1', link: 'vite-plugin-svg-icons' },
  { install: 'fast-glob@3', link: 'fast-glob' },
  { install: 'jsdom@26', link: 'jsdom' },
];
export function ensureGraderDeps(repo: string): void {
  const nm = join(repo, 'node_modules');
  if (!existsSync(nm)) return;
  const extra = join(nm, '.e2e-extra');
  const missing = GRADER_DEPS.filter((d) => !existsSync(join(nm, d.link)));
  if (!missing.length) return;
  mkdirSync(extra, { recursive: true });
  writeFileSync(join(extra, 'package.json'), JSON.stringify({ name: 'e2e-extra', private: true }));
  const r = sh('npm', ['i', '--no-audit', '--no-fund', '--legacy-peer-deps', ...GRADER_DEPS.map((d) => d.install)], extra, 600_000);
  if (r.status !== 0) throw new Error(`could not install the grader dependencies: ${(r.stderr ?? '').trim().slice(-400)}`);
  for (const d of missing) {
    const target = join(extra, 'node_modules', d.link);
    if (!existsSync(target)) throw new Error(`grader dependency ${d.link} was not installed`);
    mkdirSync(dirname(join(nm, d.link)), { recursive: true });
    symlinkSync(target, join(nm, d.link), 'junction');
  }
}

/** vitest never ran the task's check (config import error, missing dependency, no tests found): the run says nothing about the agent. */
export const isGraderError = (output: string): boolean => /Startup Error|MISSING DEPENDENCY|ERR_MODULE_NOT_FOUND|Tests\s+no tests/.test(output);

/** Run one task under one variant in its own worktree; the worktree is always removed. */
export async function runTask(task: E2eTask, variant: string, runId: string, paths: Paths, deps: HarnessDeps): Promise<E2eRow> {
  // the real (long) path: a Windows 8.3 short temp path (ISHAAN~1) makes vitest unable to resolve the copied-in test file
  const wt = mkdtempSync(join(realpathSync.native(tmpdir()), `click-e2e-${task.id}-`));
  rmSync(wt, { recursive: true, force: true }); // git wants to create it
  const add = sh('git', ['worktree', 'add', '--detach', wt, task.parentCommit], paths.repo, 120_000);
  if (add.status !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim()}`);
  try {
    // the installed dependencies are shared (read only for our purposes), so a run does not spend minutes on npm install
    const nm = join(paths.repo, 'node_modules');
    if (existsSync(nm)) symlinkSync(nm, join(wt, 'node_modules'), 'junction');
    const tscBefore = countTscErrors(sh('npx', ['vue-tsc', '--noEmit'], wt).stdout ?? '');
    if (deps.setupClick && variant !== 'V0') deps.setupClick(wt, variant);
    const agent = await deps.agent(wt, task.text);
    deps.teardownClick?.(wt);
    // what the agent changed (before the check's own test is copied in); Click's own files and the shared dependencies are not part of it
    const diff = deps.artifactDir ? (sh('git', ['add', '-A', '--', '.', ':!node_modules', ':!.click', ':!.claude'], wt), sh('git', ['diff', '--cached'], wt).stdout ?? '') : '';
    // the check: copy the task's test in, then type-check and run it
    for (const t of task.checkTests) {
      mkdirSync(join(wt, 'tests'), { recursive: true });
      cpSync(t, join(wt, 'tests', `e2e-${task.id}.test.ts`));
    }
    const tscAfter = countTscErrors(sh('npx', ['vue-tsc', '--noEmit'], wt).stdout ?? '');
    const test = sh('npx', ['vitest', 'run', `tests/e2e-${task.id}.test.ts`], wt, 300_000);
    const testPassed = test.status === 0;
    const gradeError = !testPassed && isGraderError(`${test.stdout ?? ''}${test.stderr ?? ''}`);
    if (deps.artifactDir) {
      mkdirSync(deps.artifactDir, { recursive: true });
      writeFileSync(join(deps.artifactDir, task.id + '.' + variant + '.diff'), diff);
      writeFileSync(join(deps.artifactDir, task.id + '.' + variant + '.test.txt'), ((test.stdout ?? '') + (test.stderr ?? '')).slice(-6000));
    }
    return { runId, taskId: task.id, variant, ...agent, solved: isSolved(tscBefore, tscAfter, testPassed), tscErrorsBefore: tscBefore, tscErrorsAfter: tscAfter, testPassed, ...(gradeError ? { gradeError: true } : {}) };
  } finally {
    sh('git', ['worktree', 'remove', '--force', wt], paths.repo, 120_000);
    rmSync(wt, { recursive: true, force: true });
  }
}

/** Claude Code headless. The caps make a runaway session impossible: wall clock and dollars. */
export function claudeAgent(opts: { exe: string; model?: string; maxUsd: number; timeoutMs: number }): HarnessDeps['agent'] {
  return (cwd, prompt) =>
    new Promise((resolveRun) => {
      const t0 = Date.now();
      const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--no-session-persistence', '--max-budget-usd', String(opts.maxUsd), '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'MultiEdit', 'Bash(npx vitest run:*)', 'Bash(npx vue-tsc:*)', ...(opts.model ? ['--model', opts.model] : [])];
      const child = spawn(opts.exe, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let timedOut = false;
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      const timer = setTimeout(() => {
        timedOut = true;
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
        child.kill('SIGKILL');
      }, opts.timeoutMs);
      child.on('close', () => {
        clearTimeout(timer);
        resolveRun({ ...parseClaudeStream(out), timedOut, wallMs: Date.now() - t0 });
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolveRun({ usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, turns: 0, costUsd: 0, isError: true, timedOut: false, wallMs: Date.now() - t0 });
      });
    });
}

/** Click for a worktree: index it, install the hook, start the daemon pinned to the variant's preset. */
export function clickSetup(paths: Paths): Pick<HarnessDeps, 'setupClick' | 'teardownClick'> {
  const click = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [paths.cli, ...args, '--root', cwd], { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 180_000 });
  return {
    setupClick: (cwd, variant) => {
      click(cwd, ['index']);
      click(cwd, ['hooks', 'install', '--local']);
      // the daemon: detached, pinned to the preset under test; the hook never starts one itself
      const preset = variant === 'delivery' ? 'delivery' : variant;
      const d = spawn(process.execPath, [paths.cli, 'serve', '--root', cwd], { cwd, detached: true, stdio: 'ignore', env: { ...process.env, CLICK_VARIANT: preset } });
      d.unref();
    },
    teardownClick: (cwd) => {
      try {
        const info = JSON.parse(readFileSync(join(cwd, '.click', 'daemon.json'), 'utf8')) as { pid?: number };
        if (info.pid) spawnSync('taskkill', ['/PID', String(info.pid), '/T', '/F']);
      } catch {
        // the daemon already stopped
      }
    },
  };
}

const dryAgent: HarnessDeps['agent'] = async () => ({ usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, turns: 0, costUsd: 0, isError: false, timedOut: false, wallMs: 0 });

function findClaude(): string | undefined {
  if (process.env.CLAUDE_EXE) return process.env.CLAUDE_EXE;
  const base = join(homedir(), '.vscode', 'extensions');
  try {
    const dir = readdirSync(base).filter((x) => x.startsWith('anthropic.claude-code-')).sort().pop();
    const p = dir ? join(base, dir, 'resources', 'native-binary', 'claude.exe') : '';
    return p && existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const a = process.argv.slice(2);
  const flag = (n: string, d?: string): string | undefined => (a.includes(`--${n}`) ? a[a.indexOf(`--${n}`) + 1] : d);
  const dry = a.includes('--dry');
  const limit = Number(flag('tasks', '3'));
  const repeat = Math.max(1, Number(flag('repeat', '1')));
  const variants = (flag('variants', 'V0,delivery') ?? '').split(',').filter(Boolean);
  const paths = resolvePaths();
  const only = (flag('only') ?? '').split(',').filter(Boolean);
  const tasks = loadTasks(paths.mainRoot, limit, only);
  if (!dry) ensureGraderDeps(paths.repo);
  if (!tasks.length) throw new Error('no e2e tasks found (bench/e2e/checks + bench/tasks/mined)');
  const exe = findClaude();
  if (!dry && !exe) throw new Error('claude.exe not found: set CLAUDE_EXE, or use --dry');
  const runId = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z-e2e${dry ? '-dry' : ''}`;
  const out = join(worktreeRoot, 'docs', 'e2e');
  mkdirSync(out, { recursive: true });
  const base = { ...(dry ? {} : clickSetup(paths)) };
  const deps: HarnessDeps = { artifactDir: join(out, runId), agent: dry ? dryAgent : claudeAgent({ exe: exe!, ...(flag('model') ? { model: flag('model')! } : {}), maxUsd: Number(flag('max-usd', '1.5')), timeoutMs: Number(flag('timeout-min', '10')) * 60_000 }), ...base };
  const rows: E2eRow[] = [];
  for (let rep = 1; rep <= repeat; rep++) for (const t of tasks) {
    for (const v of variants) {
      console.log(`${t.id} · ${v}${repeat > 1 ? ` · rep ${rep}/${repeat}` : ''} …`);
      const row = await runTask(t, v, runId, paths, { ...deps, ...(deps.artifactDir && repeat > 1 ? { artifactDir: join(deps.artifactDir, `rep${rep}`) } : {}) });
      rows.push(row);
      writeFileSync(join(out, `${runId}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      console.log(`  solved=${row.solved} tests=${row.testPassed} tsc ${row.tscErrorsBefore}→${row.tscErrorsAfter} tokens(in/out/cacheR/cacheW)=${row.usage.input}/${row.usage.output}/${row.usage.cacheRead}/${row.usage.cacheCreation} turns=${row.turns} ${Math.round(row.wallMs / 1000)}s $${row.costUsd.toFixed(3)}`);
    }
  }
  const invalid = rows.filter((r) => r.gradeError).map((r) => `${r.taskId}/${r.variant}`);
  if (invalid.length) console.log(`\nWARNING: ${invalid.length} run(s) could not be graded (vitest never ran the check) and are left out of the summary: ${invalid.join(', ')}`);
  const summary = { runId, dry, n: tasks.length, repeat, tasks: tasks.map((t) => t.id), invalid, variants: summarise(rows) };
  writeFileSync(join(out, `${runId}.json`), JSON.stringify(summary, null, 2) + '\n');
  console.log('\n' + JSON.stringify(summary.variants, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
