import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckResultEvent, ContextRecord, LogEvent, OutcomeEvent } from '../../../core/src/contracts.js';
import type { CommandResult, CommandRunner } from '../../../core/src/learn/check.js';
import { readEvents } from '../../../core/src/learn/log.js';
import type { BuildResult } from '../../../core/src/indexer/build.js';
import type { PackedContext } from '../../../core/src/types.js';
import type { GitOps } from './gitdiff.js';
import { changedLinesByFile, symbolsInDiff } from './gitdiff.js';
import { cleanupTemps, reference, startWorld, type World } from './testkit.js';

let ref: BuildResult;
beforeAll(async () => {
  ref = await reference();
}, 60_000);
afterAll(cleanupTemps);

const TASK = 'submitting the order fails, look at useOrderStore and the checkout button';
const OK: CommandResult = { code: 0, output: 'fine', timedOut: false, notFound: false };

interface Fakes {
  edits: string[];
  baseline: string[];
  diff: string | null;
  checks: { command: string; args: readonly string[] }[];
  checkResult: CommandResult;
}
function fakes(over: Partial<Fakes> = {}): { f: Fakes; gitOps: GitOps; runCheck: CommandRunner } {
  const f: Fakes = { edits: [], baseline: [], diff: null, checks: [], checkResult: OK, ...over };
  const gitOps: GitOps = {
    head: async () => 'abc1234',
    // the baseline query asks for the session start commit; later queries see what was edited since
    changedFiles: async () => (f.baseline.length && !f.edits.length ? f.baseline : [...f.baseline, ...f.edits]),
    diff: async () => f.diff,
  };
  const runCheck: CommandRunner = async (command, args) => (f.checks.push({ command, args }), f.checkResult);
  return { f, gitOps, runCheck };
}

const worlds: World[] = [];
async function world(over: Partial<Fakes> = {}) {
  const k = fakes(over);
  const w = await startWorld({ ref, seedGraph: false, config: { gitOps: k.gitOps, git: k.gitOps.head, runCheck: k.runCheck, learnDebounceMs: 30, debounceMs: 30 } });
  worlds.push(w);
  return { w, ...k };
}
afterAll(async () => {
  await Promise.all(worlds.map((w) => w.close()));
});

const ctx = (w: World, sessionId: string) => w.json<PackedContext>('/context', { task: TASK, sessionId, variant: 'V3' });
const records = async (w: World): Promise<ContextRecord[]> => (await readEvents<ContextRecord>(join(w.root, '.click', 'contexts.jsonl'))).events;
const outcomes = async (w: World) => (await readEvents<LogEvent>(join(w.root, '.click', 'outcomes.jsonl'))).events;
const waitFor = async (check: () => Promise<boolean> | boolean, ms = 8_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not reached in time');
};

/** The file of a non-seed item the pipeline reached over a graph path, and the edge keys of that path. */
async function reachedItem(w: World, sessionId: string): Promise<{ path: string; keys: string[]; record: ContextRecord }> {
  await w.daemon.settled();
  const rec = (await records(w)).find((r) => r.sessionId === sessionId)!;
  const [nodeId, keys] = Object.entries(rec.attribution).find(([, k]) => k.length > 0)!;
  const node = w.daemon.state.holder!.current().graph.nodes.find((n) => n.id === nodeId)!;
  return { path: node.path!, keys, record: rec };
}

describe('POST /outcome (PROMPTS 151)', () => {
  it('records an outcome for the session: contexts resolved, git edits merged (minus what was already dirty), diff symbols found', async () => {
    const { w, f } = await world({ baseline: ['already-dirty.ts'] });
    await ctx(w, 's1');
    await ctx(w, 's1');
    f.edits = ['src/stores/order.ts', 'already-dirty.ts'];
    f.diff = ['diff --git a/src/stores/order.ts b/src/stores/order.ts', '--- a/src/stores/order.ts', '+++ b/src/stores/order.ts', '@@ -1 +1 @@', '-  total: 0,', '+  useOrderStore.reset();'].join('\n');
    await w.daemon.settled();
    const r = await w.json<{ ok: boolean; eventId: string; contexts: number; filesEdited: string[]; diffSymbols: string[] }>('/outcome', {
      sessionId: 's1', filesRead: ['src/components/CheckoutButton.vue', '../outside/secret.ts'], filesEdited: ['src/components/CheckoutButton.vue'], check: { kind: 'vue-tsc' }, source: 'agent',
    });
    expect(r.status).toBe(200);
    expect(r.body.contexts).toBe(2);
    expect(r.body.filesEdited).toEqual(['src/components/CheckoutButton.vue', 'src/stores/order.ts']); // reported + git, not the file that was already dirty
    expect(r.body.diffSymbols).toContain('useOrderStore');

    const [ev] = (await outcomes(w)).filter((e): e is OutcomeEvent => e.type === 'outcome');
    expect(ev).toMatchObject({ v: 1, type: 'outcome', source: 'agent', sessionId: 's1', filesRead: ['src/components/CheckoutButton.vue'], check: { kind: 'vue-tsc' }, repoCommit: 'abc1234' });
    expect(ev!.contextIds).toHaveLength(2);
    expect(ev!.id).toBe(r.body.eventId);
  });

  it('with no passed result it queues the check; a check_result is appended and the outcome line is untouched', async () => {
    const { w, f } = await world();
    await ctx(w, 's2');
    await w.json('/outcome', { sessionId: 's2', filesEdited: ['src/stores/order.ts'], check: { kind: 'vue-tsc' } });
    await w.daemon.settled();
    expect(f.checks).toEqual([{ command: 'npx', args: ['--no-install', 'vue-tsc', '--noEmit'] }]);
    const events = await outcomes(w);
    const outcome = events.find((e): e is OutcomeEvent => e.type === 'outcome')!;
    const result = events.find((e): e is CheckResultEvent => e.type === 'check_result')!;
    expect(result).toMatchObject({ outcomeId: outcome.id, passed: true });
    expect(outcome.check.passed).toBeUndefined(); // never rewritten
    expect(events).toHaveLength(2);
  });

  it('a result that is already known is not checked again; kind none is not checked at all', async () => {
    const { w, f } = await world();
    await ctx(w, 's3');
    await w.json('/outcome', { sessionId: 's3', filesEdited: ['src/stores/order.ts'], check: { kind: 'vue-tsc', passed: true } });
    await w.json('/outcome', { sessionId: 's3', filesEdited: ['src/stores/order.ts'] }); // no check given: kind none
    await w.daemon.settled();
    expect(f.checks).toEqual([]);
    expect((await outcomes(w)).filter((e) => e.type === 'check_result')).toHaveLength(0);
  });

  it('named contextIds are used as given; unknown ones, an unknown session and a session with no contexts record nothing', async () => {
    const { w } = await world();
    const a = await ctx(w, 's4');
    await ctx(w, 's4');
    await w.daemon.settled();
    const named = await w.json<{ contexts: number }>('/outcome', { contextIds: [a.body.contextId], filesEdited: ['src/stores/order.ts'], check: { kind: 'none', passed: true } });
    expect(named.body.contexts).toBe(1);
    for (const body of [{ contextIds: ['ctx_nope'], filesEdited: [] }, { sessionId: 'never-seen', filesEdited: [] }]) {
      const r = await w.json<{ skipped?: string; eventId: unknown }>('/outcome', body);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ skipped: 'no-contexts', eventId: null });
    }
    expect((await outcomes(w)).filter((e) => e.type === 'outcome')).toHaveLength(1);
  });

  it('finds a session\'s contexts in the log after a daemon restart (memory is gone, contexts.jsonl is not)', async () => {
    const { w } = await world();
    await ctx(w, 's5');
    await w.daemon.settled();
    const rec = (await records(w))[0]!;
    w.daemon.sessions.touch('s5').contextIds.length = 0; // forget what memory knew
    const r = await w.json<{ contexts: number }>('/outcome', { sessionId: 's5', filesEdited: [], check: { kind: 'none' } });
    expect(r.body.contexts).toBe(1);
    expect((await outcomes(w))[0]).toMatchObject({ contextIds: [rec.contextId] });
  });

  it('validates the request: needs a session or contexts, bad check kind, huge lists', async () => {
    const { w } = await world();
    for (const bad of [{}, { filesEdited: ['a.ts'] }, { sessionId: '' }, { sessionId: 's', check: { kind: 'lint' } }, { sessionId: 's', source: 'carrier-pigeon' }, { sessionId: 's', filesEdited: 'a.ts' }, { contextIds: [] }]) {
      expect((await w.json('/outcome', bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe('the learning loop, end to end (PROMPTS 156)', () => {
  it('a passing outcome reinforces the path that led to an edited file: weights.json, the live graph and HydraDB edge weights all change', async () => {
    const { w } = await world();
    await ctx(w, 'L1');
    const { path, keys } = await reachedItem(w, 'L1');
    const before = (await w.json<{ weightsVersion: string | null }>('/health')).body.weightsVersion;
    expect(before).toBeNull();

    await w.json('/outcome', { sessionId: 'L1', filesEdited: [path], check: { kind: 'vue-tsc' } }); // pending: a check runs, passes, and the learner follows
    await waitFor(async () => (await w.json<{ weightsVersion: string | null }>('/health')).body.weightsVersion !== null);
    await w.daemon.settled();

    const doc = JSON.parse(readFileSync(join(w.root, '.click', 'weights.json'), 'utf8')) as { version: string; events: number; multipliers: Record<string, number> };
    expect(doc.events).toBe(1);
    for (const k of keys) expect(doc.multipliers[k], k).toBeGreaterThan(0);
    expect(keys.some((k) => doc.multipliers[k]! > 1)).toBe(true); // the path to the edited file was reinforced
    expect((await w.json<{ weightsVersion: string }>('/health')).body.weightsVersion).toBe(doc.version);
    expect(w.daemon.state.holder!.current().weights?.version).toBe(doc.version);
    expect((await w.store.getWeights())?.version).toBe(doc.version);
    const reinforced = keys.find((k) => doc.multipliers[k]! > 1)!;
    expect(w.graph.edges.get(reinforced)?.w).toBe(doc.multipliers[reinforced]); // HydraDB's edge carries the learned weight
  });

  it('a failing check teaches nothing; a later passing outcome teaches; weights.prev.json keeps the step before', async () => {
    const { w, f } = await world();
    f.checkResult = { code: 1, output: 'type error', timedOut: false, notFound: false };
    await ctx(w, 'L2');
    const { path } = await reachedItem(w, 'L2');
    await w.json('/outcome', { sessionId: 'L2', filesEdited: [path], check: { kind: 'vue-tsc' } });
    await w.daemon.settled();
    expect((await readEvents<LogEvent>(join(w.root, '.click', 'outcomes.jsonl'))).events.find((e) => e.type === 'check_result')).toMatchObject({ passed: false });
    expect(existsSync(join(w.root, '.click', 'weights.json'))).toBe(false); // nothing derived worth keeping
    expect((await w.json<{ weightsVersion: string | null }>('/health')).body.weightsVersion).toBeNull();

    await w.json('/outcome', { sessionId: 'L2', filesEdited: [path], check: { kind: 'vue-tsc', passed: true } });
    await waitFor(async () => existsSync(join(w.root, '.click', 'weights.json')));
    await w.daemon.settled();
    const first = JSON.parse(readFileSync(join(w.root, '.click', 'weights.json'), 'utf8')).version as string;

    await w.json('/outcome', { sessionId: 'L2', filesEdited: [path], check: { kind: 'vue-tsc', passed: true } });
    await waitFor(async () => (await w.daemon.weights.loadPrevious()) !== null);
    await w.daemon.settled();
    expect((await w.daemon.weights.loadPrevious())?.version).toBe(first);
    expect((await w.daemon.weights.load())?.events).toBe(3); // all three outcomes are in the log; the failed one just changed nothing
  });

  it('a burst of outcomes is one derive (5 s debounce, shortened here), and derive time is logged and small', async () => {
    const { w } = await world();
    await ctx(w, 'L3');
    const { path } = await reachedItem(w, 'L3');
    for (let i = 0; i < 12; i++) await w.json('/outcome', { sessionId: 'L3', filesEdited: [path], check: { kind: 'none', passed: true } });
    await w.daemon.settled();
    expect(w.daemon.learner.stats.runs).toBeLessThanOrEqual(3);
    expect(w.daemon.learner.stats.runs).toBeGreaterThanOrEqual(1);
    expect(w.daemon.learner.stats.lastMs).toBeLessThan(1_000);
    expect((await w.daemon.weights.load())?.events).toBe(12);
  });

  it('GET /weights summarises, POST /weights/reload makes a rolled-back file live, POST /weights/derive derives on demand', async () => {
    const { w } = await world();
    await ctx(w, 'L4');
    const { path } = await reachedItem(w, 'L4');
    await w.json('/outcome', { sessionId: 'L4', filesEdited: [path], check: { kind: 'none', passed: true } });
    await waitFor(async () => (await w.daemon.weights.load()) !== null);
    await w.daemon.settled();
    const v1 = (await w.daemon.weights.load())!;
    const s1 = await w.json<{ version: string; events: number; multipliers: number; up: unknown[]; previous: string | null }>('/weights');
    expect(s1.body).toMatchObject({ version: v1.version, events: 1, previous: null });

    await w.json('/outcome', { sessionId: 'L4', filesEdited: [path], check: { kind: 'none', passed: true } });
    await waitFor(async () => (await w.daemon.weights.load())?.events === 2);
    await w.daemon.settled();
    const rolled = await w.daemon.weights.rollback();
    expect(rolled?.to.version).toBe(v1.version);
    const reloaded = await w.json<{ version: string }>('/weights/reload', {});
    expect(reloaded.body.version).toBe(v1.version);
    expect(w.daemon.state.holder!.current().weights?.version).toBe(v1.version);
    expect((await w.json<{ weightsVersion: string }>('/health')).body.weightsVersion).toBe(v1.version);

    const derived = await w.json<{ ok: boolean; events: number; changed: boolean }>('/weights/derive', {});
    expect(derived.body).toMatchObject({ ok: true, events: 2, changed: true }); // the log still has both outcomes: derive brings the newer weights back
  });

  it('weights.json is loaded at boot (a restart keeps what was learned)', async () => {
    const { w } = await world();
    await ctx(w, 'L5');
    const { path } = await reachedItem(w, 'L5');
    await w.json('/outcome', { sessionId: 'L5', filesEdited: [path], check: { kind: 'none', passed: true } });
    await waitFor(async () => (await w.daemon.weights.load()) !== null);
    await w.daemon.settled();
    const learned = (await w.daemon.weights.load())!;
    await w.close();
    const again = await startWorld({ ref, root: w.root, seedGraph: false });
    worlds.push(again);
    expect(again.daemon.state.holder!.current().weights?.version).toBe(learned.version);
  });
});

describe('git diff helpers (PROMPTS 151)', () => {
  const DIFF = [
    'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,2 @@', '-const oldName = 1;', '+const newName = useThing();',
    'diff --git a/src/gone.ts b/src/gone.ts', 'deleted file mode 100644', '--- a/src/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-export function removedFn() {}',
    'diff --git a/src/new.ts b/src/new.ts', '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1 @@', '+export const brandNew = 1;',
  ].join('\n');

  it('changed lines per file, including deleted and new files', () => {
    const m = changedLinesByFile(DIFF);
    expect(m.get('src/a.ts')).toBe('const oldName = 1;\nconst newName = useThing();');
    expect(m.get('src/gone.ts')).toBe('export function removedFn() {}');
    expect(m.get('src/new.ts')).toBe('export const brandNew = 1;');
  });

  it('a symbol counts only when its name appears as a whole word in its OWN file\'s changed lines', () => {
    const nodes = [
      { path: 'src/a.ts', name: 'useThing' },
      { path: 'src/a.ts', name: 'use' }, // too short / not a whole word
      { path: 'src/other.ts', name: 'useThing' }, // right name, wrong file
      { path: 'src/gone.ts', name: 'removedFn' },
      { path: 'src/new.ts', name: 'brandNew' },
      { path: 'src/a.ts', name: 'newNam' }, // a prefix of a word is not the word
      { path: null, name: 'noPath' },
    ];
    expect(symbolsInDiff(DIFF, nodes)).toEqual(['brandNew', 'removedFn', 'useThing']);
    expect(symbolsInDiff('', nodes)).toEqual([]);
  });
});
