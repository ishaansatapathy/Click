import { describe, expect, it } from 'vitest';
import { countTscErrors, isSolved, parseClaudeJson, summarise, type E2eRow } from './harness.js';

const row = (variant: string, solved: boolean, over: Partial<E2eRow> = {}): E2eRow => ({
  runId: 'r', taskId: 't', variant, solved, usage: { input: 100, output: 50, cacheRead: 1000, cacheCreation: 200 }, turns: 5, costUsd: 0.1, isError: false, timedOut: false, wallMs: 20_000,
  tscErrorsBefore: 0, tscErrorsAfter: 0, testPassed: solved, ...over,
});

describe('parseClaudeJson', () => {
  it('keeps input, output, cache read and cache creation tokens separate', () => {
    const r = parseClaudeJson(JSON.stringify({ type: 'result', is_error: false, num_turns: 7, total_cost_usd: 0.42, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 } }));
    expect(r).toEqual({ usage: { input: 10, output: 20, cacheRead: 300, cacheCreation: 40 }, turns: 7, costUsd: 0.42, isError: false });
  });
  it('treats output that is not JSON, or has no usage, as an error with zero tokens (never a crash, never invented numbers)', () => {
    expect(parseClaudeJson('boom').isError).toBe(true);
    expect(parseClaudeJson('').usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    expect(parseClaudeJson('{}').usage.input).toBe(0);
  });
});

describe('solved', () => {
  it('needs the task test to pass and the type-check to get no worse', () => {
    expect(isSolved(3, 3, true)).toBe(true);
    expect(isSolved(3, 2, true)).toBe(true);
    expect(isSolved(3, 4, true)).toBe(false);
    expect(isSolved(0, 0, false)).toBe(false);
  });
  it('counts TypeScript errors in vue-tsc output', () => {
    expect(countTscErrors('src/a.ts(1,1): error TS2322: x\nsrc/b.vue(2,2): error TS7006: y\nFound 2 errors')).toBe(2);
    expect(countTscErrors('')).toBe(0);
  });
});

describe('summarise', () => {
  it('divides ALL tokens a variant spent by the tasks it solved, and reports cache reads on their own', () => {
    const [v0, click] = summarise([row('V0', true), row('V0', false), row('delivery', true), row('delivery', true)]);
    // V0 spent 2 x (100+50+200) = 700 tokens for 1 solved task; delivery spent 700 for 2
    expect(v0).toMatchObject({ variant: 'V0', n: 2, solved: 1, solveRate: 0.5, tokensPerSolved: 700, cacheReadPerSolved: 2000 });
    expect(click).toMatchObject({ variant: 'delivery', n: 2, solved: 2, tokensPerSolved: 350, cacheReadPerSolved: 1000, turnsPerSolved: 5, wallSecPerSolved: 20 });
  });
  it('says null, not zero, when a variant solved nothing', () => {
    expect(summarise([row('V0', false)])[0]).toMatchObject({ solved: 0, tokensPerSolved: null, costUsdPerSolved: null });
  });
});
