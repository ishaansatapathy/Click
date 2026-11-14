// `pnpm pair:sync [--tag <name>]`  (PROMPTS 016, PLAN §14.5). Run inside a seat's worktree.
// Optimistic concurrency: rebase onto main, prove the result green, fast-forward main. If the other seat
// won the race, main moved, so we rebase and re-check against the new main before trying again.
// main is green by construction: only a tree that passed the check on top of the current main can land.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { branchFor, readStatus, readStop, writeStatus } from './coord.js';
import { checkCommits, laneOf, makeClassifier, readPair, run, runPnpm, type Classifier, type RunResult } from './lib.js';

export type SyncStep = 'locate' | 'stop' | 'branch' | 'dirty' | 'ownership' | 'rebase' | 'install' | 'check' | 'integrate' | 'tag';

export type SyncResult =
  | { ok: true; head: string; attempts: number; noop: boolean; tagged?: string }
  | { ok: false; step: SyncStep; message: string };

export interface SyncOptions {
  cwd: string;
  tag?: string;
  check?: (cwd: string) => Promise<RunResult>;
  install?: (cwd: string) => Promise<RunResult>;
  classify?: Classifier;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
  log?: (line: string) => void;
}

// git's wording for "someone else got there first"; these are worth a retry.
const TRANSIENT = /index\.lock|not possible to fast-forward|cannot fast-forward|diverging|cannot lock ref|unable to create .*\.lock/i;

const fail = (step: SyncStep, message: string): SyncResult => ({ ok: false, step, message });
const tail = (s: string, n = 30): string => s.trim().split(/\r?\n/).slice(-n).join('\n');

async function out(args: string[], cwd: string): Promise<{ code: number; text: string; err: string }> {
  const r = await run('git', args, { cwd });
  return { code: r.code, text: r.stdout.trim(), err: r.stderr.trim() };
}

export async function sync(o: SyncOptions): Promise<SyncResult> {
  const log = o.log ?? ((l: string) => process.stdout.write(l + '\n'));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = o.random ?? Math.random;
  const check = o.check ?? ((cwd: string) => runPnpm(['check'], { cwd }));
  const install = o.install ?? ((cwd: string) => runPnpm(['install', '--frozen-lockfile'], { cwd }));
  const classify = o.classify ?? makeClassifier();
  const maxAttempts = o.maxAttempts ?? 3;

  // 0. Where are we?
  const pair = readPair(o.cwd);
  if (!pair?.seat || !pair.worktree) return fail('locate', 'Run pair:sync inside a seat worktree (no .pair.json found).');
  const { seat, main } = pair;
  const wt = pair.worktree;
  if (!existsSync(main)) return fail('locate', `MAIN not found at ${main}`);

  // 1. Stop the line?
  const stop = readStop(main);
  if (stop) return fail('stop', `coord/STOP is set, so nobody integrates until it is cleared:\n${stop}\nKeep working and committing locally.`);

  // 2. Right branch, clean tree.
  const branch = await out(['symbolic-ref', '--short', 'HEAD'], wt);
  if (branch.code !== 0 || branch.text !== branchFor(seat)) {
    return fail('branch', `Worktree must be on ${branchFor(seat)} (found "${branch.text || 'detached HEAD'}").`);
  }
  const dirty = await out(['status', '--porcelain', '--untracked-files=no'], wt);
  if (dirty.text) return fail('dirty', `Uncommitted changes to tracked files: commit them first.\n${dirty.text}`);

  // 3. Ownership of every unintegrated commit.
  const violations = await checkCommits('main..HEAD', seat, wt, classify);
  if (violations.length) {
    const lines = violations.map((v) => `  ${v.sha?.slice(0, 8)} "${v.subject}": ${v.path} (${v.cls}): ${v.reason}`);
    return fail('ownership', `Ownership violations (PLAN §14.4). Fix the commits, then sync again:\n${lines.join('\n')}`);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 4. Rebase onto the current main.
    const lockBefore = (await out(['rev-parse', 'HEAD:pnpm-lock.yaml'], wt)).text;
    const rebase = await out(['rebase', 'main'], wt);
    if (rebase.code !== 0) {
      const conflicted = (await out(['diff', '--name-only', '--diff-filter=U'], wt)).text.split(/\r?\n/).filter(Boolean);
      await out(['rebase', '--abort'], wt);
      const own = laneOf(seat);
      const notMine = conflicted.filter((p) => classify(p) !== own);
      const hint = notMine.length
        ? `Conflicts in files you don't own: ${notMine.join(', ')}. Don't resolve them: file a T9 request (lockfile: take main's, re-run pnpm install, commit as deps:).`
        : `Conflicts only in your own files: ${conflicted.join(', ')}. Run "git rebase main", resolve, "git rebase --continue", then sync again.`;
      return fail('rebase', `Rebase onto main failed; rebase aborted, nothing changed.\n${hint}\n${tail(rebase.err)}`);
    }

    // 5. Dependencies, if the lockfile moved.
    const lockAfter = (await out(['rev-parse', 'HEAD:pnpm-lock.yaml'], wt)).text;
    if (lockAfter !== lockBefore) {
      log('Lockfile changed: installing…');
      const r = await install(wt);
      if (r.code !== 0) return fail('install', `pnpm install --frozen-lockfile failed:\n${tail(r.stdout + r.stderr)}`);
    }

    const head = (await out(['rev-parse', 'HEAD'], wt)).text;
    const mainSha = (await out(['rev-parse', 'main'], wt)).text;
    if (head === mainSha) {
      const tagged = await applyTag(o.tag, head, wt);
      if (typeof tagged === 'object') return tagged;
      return { ok: true, head, attempts: attempt, noop: true, tagged: o.tag };
    }

    // 6. Prove it green on top of the current main.
    log(`Attempt ${attempt}: running pnpm check on ${head.slice(0, 8)}…`);
    const c = await check(wt);
    if (c.code !== 0) return fail('check', `pnpm check failed after rebasing onto main; main was not touched. See T1/T8.\n${tail(c.stdout + c.stderr)}`);

    // 7. Fast-forward main (in MAIN's checkout) to exactly the commit we tested.
    const merge = await out(['merge', '--ff-only', '--quiet', head], main);
    if (merge.code === 0) {
      const tagged = await applyTag(o.tag, head, wt);
      if (typeof tagged === 'object') return tagged;
      const status = readStatus(main, seat);
      writeStatus(main, { ...status, lastIntegrated: (o.now ?? (() => new Date()))().toISOString() });
      log(`Integrated ${head.slice(0, 8)} into main${o.tag ? ` and tagged ${o.tag}` : ''}.`);
      return { ok: true, head, attempts: attempt, noop: false, tagged: o.tag };
    }
    if (!TRANSIENT.test(merge.err) || attempt === maxAttempts) {
      return fail('integrate', `Fast-forward of main failed${attempt === maxAttempts ? ` after ${attempt} attempts` : ''}:\n${tail(merge.err)}`);
    }
    const wait = 300 + Math.floor(random() * 1200);
    log(`main moved under us (the other seat integrated). Retrying in ${wait} ms…`);
    await sleep(wait);
  }
  return fail('integrate', 'unreachable');
}

/** Tag the integrated commit. Re-tagging the same commit is fine; moving an existing tag is not. */
async function applyTag(tag: string | undefined, head: string, cwd: string): Promise<true | SyncResult> {
  if (!tag) return true;
  const existing = await out(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], cwd);
  if (existing.code === 0) {
    return existing.text === head ? true : fail('tag', `Tag ${tag} already exists at ${existing.text.slice(0, 8)}; tags are signals and never move.`);
  }
  const r = await out(['tag', tag, head], cwd);
  return r.code === 0 ? true : fail('tag', `Could not create tag ${tag}: ${r.err}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--tag');
  const tag = i >= 0 ? args[i + 1] : undefined;
  if (i >= 0 && !tag) throw new Error('--tag needs a name, e.g. --tag sync/build');
  const r = await sync({ cwd: process.cwd(), tag });
  if (!r.ok) {
    process.stderr.write(`pair:sync refused at step "${r.step}":\n${r.message}\n`);
    process.exitCode = 1;
  } else if (r.noop) {
    process.stdout.write(`Nothing to integrate: already at main${r.tagged ? ` (tag ${r.tagged} ok)` : ''}.\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e: unknown) => {
    process.stderr.write(`pair:sync failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
