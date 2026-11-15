import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckResultEvent, LogEvent, OutcomeEvent } from '../contracts.js';
import { CheckQueue, commandsFor, runCommand, type CommandResult, type CommandRunner } from './check.js';
import { EventLog } from './log.js';

let dir: string;
let log: EventLog<LogEvent>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'click-check-'));
  log = new EventLog<LogEvent>(join(dir, 'outcomes.jsonl'));
});
afterEach(async () => {
  // a timed-out check may leave a process that still has the directory as its working directory; Windows refuses to delete it for a moment
  for (let i = 0; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i >= 40) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
});

let n = 0;
const outcome = (over: Partial<OutcomeEvent> = {}): OutcomeEvent => ({
  v: 1, type: 'outcome', id: `o${++n}`, ts: '2026-11-15T10:00:00.000Z', source: 'agent', contextIds: ['c1'], filesRead: [], filesEdited: ['src/a.ts'], diffSymbols: [], check: { kind: 'vue-tsc' }, repoCommit: null, ...over,
});
const ok: CommandResult = { code: 0, output: 'fine', timedOut: false, notFound: false };

interface Call {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}
function fake(results: (CommandResult | ((c: Call) => Promise<CommandResult>))[]): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  return {
    calls,
    run: async (command, args, o) => {
      const call = { command, args, ...o };
      calls.push(call);
      const r = results[Math.min(i++, results.length - 1)]!;
      return typeof r === 'function' ? r(call) : r;
    },
  };
}
const results = async (): Promise<CheckResultEvent[]> => (await log.read()).events.filter((e): e is CheckResultEvent => e.type === 'check_result');

describe('CheckQueue (PROMPTS 152)', () => {
  it('runs vue-tsc in the repo and appends a passing check_result; the outcome is never touched', async () => {
    const f = fake([ok]);
    const seen: CheckResultEvent[] = [];
    const q = new CheckQueue({ root: dir, outcomes: log, run: f.run, onResult: (r) => seen.push(r) });
    const o = outcome();
    await log.append(o);
    q.enqueue(o);
    await q.idle();
    expect(f.calls).toEqual([{ command: 'npx', args: ['--no-install', 'vue-tsc', '--noEmit'], cwd: dir, timeoutMs: 120_000 }]);
    const r = await results();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ v: 1, type: 'check_result', outcomeId: o.id, passed: true, summary: expect.stringContaining('vue-tsc') });
    expect(seen).toEqual(r);
    const all = (await log.read()).events;
    expect(all.filter((e) => e.type === 'outcome')).toEqual([o]); // exactly what was written, unchanged
  });

  it('a failing check records passed: false with the tail of the output as the summary', async () => {
    const q = new CheckQueue({ root: dir, outcomes: log, run: fake([{ code: 2, output: `${'x'.repeat(2_000)}\nerror TS2322: Type 'string' is not assignable`, timedOut: false, notFound: false }]).run });
    q.enqueue(outcome());
    await q.idle();
    const [r] = await results();
    expect(r!.passed).toBe(false);
    expect(r!.summary).toContain('TS2322');
    expect(r!.summary!.length).toBeLessThanOrEqual(500);
  });

  it('a timeout counts as failed, and says so', async () => {
    const q = new CheckQueue({ root: dir, outcomes: log, run: fake([{ code: null, output: '', timedOut: true, notFound: false }]).run, timeoutMs: 5 });
    q.enqueue(outcome());
    await q.idle();
    const [r] = await results();
    expect(r).toMatchObject({ passed: false, summary: expect.stringContaining('timed out') });
  });

  it('a tool that is not installed writes NO result: unknown stays unknown', async () => {
    const q = new CheckQueue({ root: dir, outcomes: log, run: fake([{ code: 127, output: 'not found', timedOut: false, notFound: true }]).run });
    q.enqueue(outcome());
    await q.idle();
    expect(await results()).toEqual([]);
    expect(q.stats.skipped).toBe(1);
  });

  it('vitest runs only the test files (from check.files, else the edited ones); with none, nothing runs and nothing is written', async () => {
    const f = fake([ok]);
    const q = new CheckQueue({ root: dir, outcomes: log, run: f.run });
    q.enqueue(outcome({ check: { kind: 'vitest' }, filesEdited: ['src/a.ts', 'src/a.test.ts', 'src/b.spec.tsx'] }));
    await q.idle();
    expect(f.calls[0]).toMatchObject({ command: 'npx', args: ['--no-install', 'vitest', 'run', 'src/a.test.ts', 'src/b.spec.tsx'] });
    q.enqueue(outcome({ check: { kind: 'vitest', files: ['tests/x.test.ts'] }, filesEdited: ['src/a.test.ts'] }));
    await q.idle();
    expect(f.calls[1]!.args.slice(-1)).toEqual(['tests/x.test.ts']);
    q.enqueue(outcome({ check: { kind: 'vitest' }, filesEdited: ['src/a.ts'] }));
    await q.idle();
    expect(f.calls).toHaveLength(2);
    expect(await results()).toHaveLength(2);
  });

  it('vue-tsc+vitest: both must pass, and a failing vue-tsc stops before vitest', async () => {
    const both = fake([ok, ok]);
    const q1 = new CheckQueue({ root: dir, outcomes: log, run: both.run });
    q1.enqueue(outcome({ check: { kind: 'vue-tsc+vitest' }, filesEdited: ['src/a.test.ts'] }));
    await q1.idle();
    expect(both.calls.map((c) => c.args[1])).toEqual(['vue-tsc', 'vitest']);
    expect((await results())[0]!.passed).toBe(true);

    const failFirst = fake([{ code: 1, output: 'type error', timedOut: false, notFound: false }, ok]);
    const q2 = new CheckQueue({ root: dir, outcomes: log, run: failFirst.run });
    q2.enqueue(outcome({ check: { kind: 'vue-tsc+vitest' }, filesEdited: ['src/a.test.ts'] }));
    await q2.idle();
    expect(failFirst.calls).toHaveLength(1);
    expect((await results()).at(-1)!.passed).toBe(false);
  });

  it('does nothing for outcomes whose result is already known or whose kind is none', async () => {
    const f = fake([ok]);
    const q = new CheckQueue({ root: dir, outcomes: log, run: f.run });
    q.enqueue(outcome({ check: { kind: 'vue-tsc', passed: true } }));
    q.enqueue(outcome({ check: { kind: 'none' } }));
    await q.idle();
    expect(f.calls).toEqual([]);
    expect(await results()).toEqual([]);
  });

  it('concurrency 1: checks run one after the other, in order, never overlapping', async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const slow: CommandRunner = async (_c, args) => {
      active++;
      peak = Math.max(peak, active);
      order.push(args.join(' '));
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return ok;
    };
    const q = new CheckQueue({ root: dir, outcomes: log, run: slow });
    for (let i = 0; i < 4; i++) q.enqueue(outcome({ check: { kind: 'vue-tsc' } }));
    expect(q.busy).toBe(true);
    await q.idle();
    expect(peak).toBe(1);
    expect(order).toHaveLength(4);
    expect(await results()).toHaveLength(4);
  });

  it('a runner that throws, or an append that fails, never breaks the queue', async () => {
    const q = new CheckQueue({ root: dir, outcomes: log, run: fake([async () => Promise.reject(new Error('spawn exploded')), ok]).run });
    q.enqueue(outcome());
    q.enqueue(outcome());
    await q.idle();
    expect(await results()).toHaveLength(1); // the first blew up, the second still ran
  });

  it('close() stops new work', async () => {
    const f = fake([ok]);
    const q = new CheckQueue({ root: dir, outcomes: log, run: f.run });
    q.close();
    q.enqueue(outcome());
    await q.idle();
    expect(f.calls).toEqual([]);
  });
});

describe('commandsFor', () => {
  it('maps each kind to the right commands', () => {
    expect(commandsFor(outcome({ check: { kind: 'none' } }))).toEqual([]);
    expect(commandsFor(outcome({ check: { kind: 'vue-tsc' } }))).toEqual([['npx', ['--no-install', 'vue-tsc', '--noEmit']]]);
    expect(commandsFor(outcome({ check: { kind: 'vue-tsc+vitest' }, filesEdited: ['src/a.ts'] }))).toEqual([['npx', ['--no-install', 'vue-tsc', '--noEmit']]]); // no tests to run: just the type check
  });
});

describe('runCommand (real processes)', () => {
  it('captures output and exit code, recognises a missing tool, and enforces the timeout', async () => {
    const script = join(dir, 'exit.js');
    writeFileSync(script, "console.log('hello from the check'); process.exit(3);");
    const failed = await runCommand(process.execPath, [script], { cwd: dir, timeoutMs: 20_000 });
    expect(failed).toMatchObject({ code: 3, timedOut: false, notFound: false });
    expect(failed.output).toContain('hello from the check');

    const missing = await runCommand('definitely-not-a-real-tool-xyz', [], { cwd: dir, timeoutMs: 20_000 });
    expect(missing.notFound).toBe(true);

    mkdirSync(join(dir, 'sub'));
    const hang = join(dir, 'sub', 'hang.js');
    writeFileSync(hang, 'setInterval(() => {}, 1000);');
    const t0 = Date.now();
    const timedOut = await runCommand(process.execPath, [hang], { cwd: dir, timeoutMs: 300 });
    expect(timedOut.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 60_000);
});
