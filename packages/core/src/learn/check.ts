// PROMPTS 152: did the agent's work actually pass? The learner only trusts a result it can see, so after an outcome whose check is not
// known yet, a background queue runs the project's own check (`vue-tsc --noEmit`, `vitest run <files>`, or both) and appends a
// `check_result` event. The outcome event itself is never touched (the log is append-only).
//   - one check at a time (concurrency 1), 120 s limit each; a check that times out counts as failed
//   - a check that cannot run at all (the tool is not installed, no test files to run) writes NO result: an unknown stays unknown,
//     it is not a failure, and nothing is learned from it
//   - commands are injectable, so tests use fakes

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { CheckResultEvent, OutcomeEvent } from '../contracts.js';
import type { Logger } from '../util/log.js';
import { newEventId, type EventLog } from './log.js';

export const CHECK_TIMEOUT_MS = 120_000;

export interface CommandResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  /** The program does not exist (or could not be started). */
  notFound: boolean;
}

export type CommandRunner = (command: string, args: readonly string[], o: { cwd: string; timeoutMs: number }) => Promise<CommandResult>;

const quote = (a: string): string => (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);

/** Runs `npx --no-install <tool> …` through the shell (so `.cmd` shims work on Windows) and collects the tail of the output. */
export const runCommand: CommandRunner = (command, args, { cwd, timeoutMs }) =>
  new Promise((resolve) => {
    const child = spawn(`${quote(command)} ${args.map(quote).join(' ')}`, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const take = (d: Buffer): void => {
      output = (output + d.toString('utf8')).slice(-4_000);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    let done = false;
    const finish = (r: CommandResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      setTimeout(() => finish({ code: null, output, timedOut: true, notFound: false }), 2_000).unref(); // do not wait forever for pipes a grandchild holds
    }, timeoutMs);
    child.on('error', () => finish({ code: null, output, timedOut, notFound: true }));
    child.on('close', (code) => {
      // 127 (sh) and 9009 / "not recognized" (cmd) mean the tool is not there; npx --no-install exits 1 with "could not determine executable"
      const missing = !timedOut && (code === 127 || code === 9009 || /not recognized as an internal or external command|command not found|could not determine executable|ENOENT/i.test(output));
      finish({ code, output, timedOut, notFound: missing });
    });
  });

/** Kill a process and everything it started (a shell's child outlives the shell otherwise, and keeps its pipes open). */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

export interface CheckQueueOptions {
  root: string;
  outcomes: Pick<EventLog<CheckResultEvent | OutcomeEvent>, 'append'>;
  log?: Logger;
  run?: CommandRunner;
  timeoutMs?: number;
  now?: () => number;
  /** Called after a check_result was appended (the learner re-derives on it). */
  onResult?: (result: CheckResultEvent) => void;
}

export class CheckQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private waiters: (() => void)[] = [];
  readonly stats = { run: 0, skipped: 0, appended: 0 };

  constructor(private readonly o: CheckQueueOptions) {}

  /** Queue the check of an outcome whose result is not known yet. Never throws; does nothing when there is nothing to run. */
  enqueue(outcome: OutcomeEvent): void {
    if (this.closed || outcome.check.passed !== undefined || outcome.check.kind === 'none') return;
    this.pending++;
    this.tail = this.tail.then(() => this.check(outcome)).catch((e: unknown) => this.o.log?.warn('check failed to run', { error: e, outcomeId: outcome.id })).finally(() => {
      this.pending--;
      if (this.pending === 0) this.waiters.splice(0).forEach((r) => r());
    });
  }

  get busy(): boolean {
    return this.pending > 0;
  }

  idle(): Promise<void> {
    return this.pending > 0 ? new Promise((r) => this.waiters.push(r)) : Promise.resolve();
  }

  close(): void {
    this.closed = true;
  }

  private async check(outcome: OutcomeEvent): Promise<void> {
    if (this.closed) return;
    const run = this.o.run ?? runCommand;
    const now = this.o.now ?? Date.now;
    const timeoutMs = this.o.timeoutMs ?? CHECK_TIMEOUT_MS;
    const t0 = now();
    const steps = commandsFor(outcome);
    if (steps.length === 0) {
      this.stats.skipped++;
      return;
    }
    this.stats.run++;
    let passed = true;
    let summary = '';
    for (const [command, args] of steps) {
      const r = await run(command, args, { cwd: this.o.root, timeoutMs });
      if (r.notFound) {
        this.stats.skipped++;
        this.o.log?.warn('check not run: the tool is not available in this repo', { outcomeId: outcome.id, command, args });
        return; // unknown stays unknown
      }
      if (r.timedOut) {
        passed = false;
        summary = `timed out after ${Math.round(timeoutMs / 1000)} s: ${command} ${args.join(' ')}`;
        break;
      }
      if (r.code !== 0) {
        passed = false;
        summary = r.output.trim().slice(-500) || `exit code ${String(r.code)}: ${command} ${args.join(' ')}`;
        break; // the first failing step decides; later steps are not needed
      }
      summary = `${command} ${args.join(' ')}: ok`;
    }
    const result: CheckResultEvent = { v: 1, type: 'check_result', id: newEventId(now()), ts: new Date(now()).toISOString(), outcomeId: outcome.id, passed, ms: Math.max(0, now() - t0), summary };
    await this.o.outcomes.append(result);
    this.stats.appended++;
    this.o.onResult?.(result);
  }
}

/** What to run for an outcome's `check`. Empty when there is nothing sensible to run. */
export function commandsFor(outcome: OutcomeEvent): [string, string[]][] {
  const { kind, files } = outcome.check;
  const tsc: [string, string[]] = ['npx', ['--no-install', 'vue-tsc', '--noEmit']];
  const testFiles = (files ?? outcome.filesEdited).filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
  const tests: [string, string[]][] = testFiles.length ? [['npx', ['--no-install', 'vitest', 'run', ...testFiles]]] : [];
  if (kind === 'vue-tsc') return [tsc];
  if (kind === 'vitest') return tests;
  if (kind === 'vue-tsc+vitest') return tests.length ? [tsc, ...tests] : [tsc];
  return [];
}

export const localBin = (root: string, tool: string): string => join(root, 'node_modules', '.bin', tool);
