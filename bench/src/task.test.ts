import { describe, expect, it } from 'vitest';

import { benchTaskSchema, taskCommitFileError, taskCommitShas, validateTasks } from './task.js';

const commit = 'abcdef0123456789abcdef0123456789abcdef01';
function task(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'm-abcdef0',
    source: 'mined',
    commit,
    parentCommit: '1234567890abcdef1234567890abcdef12345678',
    date: '2025-01-01T00:00:00Z',
    text: 'Improve the account preferences experience.',
    type: 'multi-file',
    groundTruth: { files: ['src/a.ts'], symbols: ['sym:src/a.ts#loadAccount'] },
    split: 'train',
    e2e: false,
    ...overrides,
  };
}

describe('benchTaskSchema', () => {
  it('accepts the SPEC task shape', () => {
    expect(benchTaskSchema.parse(task())).toMatchObject({ id: 'm-abcdef0', split: 'train' });
    expect(benchTaskSchema.parse(task({ id: 'h-01', source: 'hand', commit: undefined }))).toMatchObject({ id: 'h-01' });
  });

  it('rejects invalid IDs, split values, paths, and node IDs', () => {
    expect(benchTaskSchema.safeParse(task({ id: 'mined-1' })).success).toBe(false);
    expect(benchTaskSchema.safeParse(task({ split: 'validation' })).success).toBe(false);
    expect(benchTaskSchema.safeParse(task({ groundTruth: { files: ['../a.ts'], symbols: [] } })).success).toBe(false);
    expect(benchTaskSchema.safeParse(task({ groundTruth: { files: ['src/a.ts'], symbols: ['loadAccount'] } })).success).toBe(false);
  });

  it('requires a mined ID to agree with its commit', () => {
    expect(benchTaskSchema.safeParse(task({ id: 'm-1234567' })).success).toBe(false);
  });
});

describe('validateTasks', () => {
  it('honours rejected IDs and commit SHAs', () => {
    const values = [
      { value: task(), origin: 'tasks.jsonl:1' },
      { value: task({ id: 'h-01', source: 'hand', commit: undefined }), origin: 'hand.json' },
    ];
    expect(validateTasks(values, new Set(['src/a.ts']), new Set(['sym:src/a.ts#loadAccount']), new Set([commit]))).toMatchObject({
      tasks: [{ id: 'h-01' }], rejected: 1, errors: [],
    });
  });

  it('reports duplicate IDs and files missing at H', () => {
    const values = [
      { value: task(), origin: 'a.json' },
      { value: task(), origin: 'b.json' },
    ];
    const result = validateTasks(values, new Set(), new Set(), new Set());
    expect(result.errors).toContain('duplicate task ID: m-abcdef0 (2 occurrences)');
    expect(result.errors.filter((error) => error.includes('ground-truth file does not exist at H'))).toHaveLength(2);
  });

  it('reports symbols missing from the graph at H', () => {
    const result = validateTasks([{ value: task(), origin: 'task.json' }], new Set(['src/a.ts']), new Set(), new Set());
    expect(result.errors).toEqual(['m-abcdef0: ground-truth symbol does not exist at H: sym:src/a.ts#loadAccount']);
  });

  it('reports schema errors with their origin', () => {
    const result = validateTasks([{ value: task({ split: 'bad' }), origin: 'bad.json:4' }], new Set(), new Set(), new Set());
    expect(result.errors[0]).toContain('bad.json:4: split:');
  });
});

describe('task commit leakage list', () => {
  it('contains sorted unique SHAs for accepted mined tasks only', () => {
    const mined = benchTaskSchema.parse(task());
    const hand = benchTaskSchema.parse(task({ id: 'h-01', source: 'hand', commit: undefined }));
    expect(taskCommitShas([hand, mined, mined])).toEqual([commit]);
    expect(taskCommitFileError([hand, mined], `${commit}\n`)).toBeNull();
  });

  it('reports missing, extra, duplicate, or unsorted entries as stale', () => {
    const mined = benchTaskSchema.parse(task());
    expect(taskCommitFileError([mined], '')).toMatch(/stale/);
    expect(taskCommitFileError([mined], `${commit}\n${commit}\n`)).toMatch(/stale/);
  });
});
