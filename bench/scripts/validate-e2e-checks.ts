// Validate E2E graders against history: every check must fail before the change and pass at the real fix commit.
// Worktrees deliberately live under a long, ordinary Windows path. A DOS 8.3 path can hide module-resolution bugs.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

export interface ValidationCase {
  id: string;
  text: string;
  parentCommit: string;
  commit: string;
  checkPath: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const clickRoot = resolve(here, '..', '..');

export function loadValidationCases(tasksDir: string, checksDir: string, requested: readonly string[] = []): ValidationCase[] {
  const wanted = new Set(requested);
  const files = readdirSync(checksDir).filter((file) => file.endsWith('.test.ts')).sort();
  const cases = files.flatMap((file): ValidationCase[] => {
    const id = file.replace(/\.test\.ts$/, '');
    if (wanted.size && !wanted.has(id)) return [];
    const taskPath = join(tasksDir, `${id}.json`);
    if (!existsSync(taskPath)) throw new Error(`${file} has no mined task ${taskPath}`);
    const task = JSON.parse(readFileSync(taskPath, 'utf8')) as Partial<ValidationCase> & { e2e?: boolean };
    if (!task.text?.trim()) throw new Error(`${id} has no task text to justify its check`);
    if (!/^[a-f0-9]{40}$/i.test(task.parentCommit ?? '')) throw new Error(`${id} has an invalid parentCommit`);
    if (!/^[a-f0-9]{40}$/i.test(task.commit ?? '')) throw new Error(`${id} has an invalid fix commit`);
    if (task.e2e !== true) throw new Error(`${id} has a check but is not marked e2e`);
    return [{ id, text: task.text, parentCommit: task.parentCommit!, commit: task.commit!, checkPath: join(checksDir, file) }];
  });
  for (const id of wanted) if (!cases.some((item) => item.id === id)) throw new Error(`requested E2E check not found: ${id}`);
  if (!cases.length) throw new Error('no E2E checks selected');
  return cases;
}

export function longWorktreePath(root: string, id: string, revision: 'parent' | 'fix', nonce = randomBytes(4).toString('hex')): string {
  return resolve(root, '.tmp', 'e2e-check-validation-real-long-path-never-dos-eight-dot-three', `${id}-${revision}-${nonce}`);
}

export function assertRealLongPath(path: string): void {
  if (path.includes('~')) throw new Error(`validation path must not use an 8.3 short segment: ${path}`);
  if (path.length < 100) throw new Error(`validation path is not long enough to exercise real Windows paths (${path.length} chars): ${path}`);
}

export function assertHistoricalOutcomes(id: string, parentExit: number | null, fixExit: number | null): void {
  if (parentExit === 0) throw new Error(`${id}: check unexpectedly PASSED at parentCommit`);
  if (parentExit === null) throw new Error(`${id}: parent check did not exit normally`);
  if (fixExit !== 0) throw new Error(`${id}: check did not PASS at the real fix commit (exit ${fixExit ?? 'signal'})`);
}

const tail = (value: string, lines = 30): string => value.trim().split(/\r?\n/).slice(-lines).join('\n');

function mainRoot(): string {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: clickRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`cannot locate MAIN: ${tail(result.stderr)}`);
  return dirname(result.stdout.trim());
}

function git(repo: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync('git', ['-c', `safe.directory=${repo}`, '-C', repo, ...args], { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
}

function runCheck(repo: string, sourceCheck: string, revision: string, destination: string): SpawnSyncReturns<string> {
  const add = git(repo, ['worktree', 'add', '--detach', destination, revision]);
  if (add.status !== 0) throw new Error(`git worktree add failed for ${revision}: ${tail(add.stderr)}`);
  try {
    const modules = join(repo, 'node_modules');
    if (!existsSync(modules)) throw new Error(`benchmark dependencies are missing: ${modules}`);
    symlinkSync(modules, join(destination, 'node_modules'), 'junction');
    const targetDir = join(destination, 'tests');
    mkdirSync(targetDir, { recursive: true });
    const target = join(targetDir, `e2e-${revision.slice(0, 7)}.test.ts`);
    const config = join(targetDir, 'validator.vitest.config.mjs');
    const setup = join(targetDir, 'validator.setup.mjs');
    cpSync(sourceCheck, target);
    // Historical app configs import version-specific Vite plugins. These source-level graders need only Vitest's Node runtime.
    // The app normally gets Vue APIs from unplugin-auto-import, so reproduce those globals without loading the historical Vite stack.
    writeFileSync(setup, 'import * as Vue from "vue"; import * as Pinia from "pinia"; Object.assign(globalThis, { computed: Vue.computed, nextTick: Vue.nextTick, onBeforeUnmount: Vue.onBeforeUnmount, onMounted: Vue.onMounted, onUnmounted: Vue.onUnmounted, reactive: Vue.reactive, readonly: Vue.readonly, ref: Vue.ref, shallowRef: Vue.shallowRef, toRefs: Vue.toRefs, unref: Vue.unref, watch: Vue.watch, watchEffect: Vue.watchEffect, acceptHMRUpdate: Pinia.acceptHMRUpdate, defineStore: Pinia.defineStore, storeToRefs: Pinia.storeToRefs });\n');
    writeFileSync(config, `export default { resolve: { alias: [{ find: "@@", replacement: ${JSON.stringify(join(destination, 'src', 'common'))} }, { find: "@", replacement: ${JSON.stringify(join(destination, 'src'))} }] }, test: { environment: "node", setupFiles: [${JSON.stringify(setup)}] } };\n`);
    const vitest = join(modules, 'vitest', 'vitest.mjs');
    if (!existsSync(vitest)) throw new Error(`vitest entry point is missing: ${vitest}`);
    return spawnSync(process.execPath, [vitest, 'run', target, '--config', config], { cwd: destination, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024, shell: false });
  } finally {
    git(repo, ['worktree', 'remove', '--force', destination]);
    rmSync(destination, { recursive: true, force: true });
  }
}

export function parseIds(args: readonly string[]): string[] {
  const index = args.indexOf('--ids');
  if (index < 0) {
    if (args.length) throw new Error(`unknown arguments: ${args.join(' ')}`);
    return [];
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error('--ids needs a comma-separated list');
  const unknown = args.filter((arg, i) => i !== index && i !== index + 1);
  if (unknown.length) throw new Error(`unknown arguments: ${unknown.join(' ')}`);
  return value.split(',').map((id) => id.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const root = mainRoot();
  const repo = resolve(root, 'bench', 'repo');
  const selected = loadValidationCases(resolve(clickRoot, 'bench', 'tasks', 'mined'), resolve(clickRoot, 'bench', 'e2e', 'checks'), parseIds(process.argv.slice(2)));
  process.stdout.write(`Validating ${selected.length} E2E check(s) at parent and fix commits\n`);
  for (const item of selected) {
    const parentPath = longWorktreePath(clickRoot, item.id, 'parent');
    const fixPath = longWorktreePath(clickRoot, item.id, 'fix');
    assertRealLongPath(parentPath);
    assertRealLongPath(fixPath);
    const parent = runCheck(repo, item.checkPath, item.parentCommit, parentPath);
    const fix = runCheck(repo, item.checkPath, item.commit, fixPath);
    try {
      assertHistoricalOutcomes(item.id, parent.status, fix.status);
    } catch (error) {
      const detail = [
        `parent output:\n${tail(`${parent.stdout ?? ''}\n${parent.stderr ?? ''}\n${parent.error?.message ?? ''}`)}`,
        `fix output:\n${tail(`${fix.stdout ?? ''}\n${fix.stderr ?? ''}\n${fix.error?.message ?? ''}`)}`,
      ].join('\n');
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`);
    }
    process.stdout.write(`PASS ${item.id}: parent failed, fix passed (${parentPath.length}/${fixPath.length} char paths)\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`validate-e2e-checks: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
