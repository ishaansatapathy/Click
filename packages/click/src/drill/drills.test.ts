import { describe, expect, it } from 'vitest';
import { judgeHookRun, type HookRun } from './drills.js';

const run = (over: Partial<HookRun>): HookRun => ({ exitCode: 0, ms: 200, stdout: '', stderr: '', ...over });
const ctx = (n: number): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'x'.repeat(n) } });

describe('judgeHookRun: what "never blocks the developer" means', () => {
  it('accepts empty output and valid context', () => {
    expect(judgeHookRun(run({})).ok).toBe(true);
    expect(judgeHookRun(run({ stdout: ctx(9_800) })).ok).toBe(true);
  });
  it('rejects any exit code but 0 (2 would block the prompt)', () => {
    expect(judgeHookRun(run({ exitCode: 2 })).ok).toBe(false);
    expect(judgeHookRun(run({ exitCode: null })).ok).toBe(false);
  });
  it('rejects a hook slower than its timeout', () => {
    expect(judgeHookRun(run({ ms: 3_001 })).ok).toBe(false);
    expect(judgeHookRun(run({ ms: 2_999 })).ok).toBe(true);
  });
  it('rejects output that is not the documented shape, or that Claude Code would truncate', () => {
    expect(judgeHookRun(run({ stdout: 'not json' })).ok).toBe(false);
    expect(judgeHookRun(run({ stdout: '{"a":1}' })).ok).toBe(false);
    expect(judgeHookRun(run({ stdout: ctx(10_001) })).ok).toBe(false);
  });
});
