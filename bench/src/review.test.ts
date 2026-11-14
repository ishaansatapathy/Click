import { describe, expect, it } from 'vitest';

import type { BenchTask } from './task.js';
import { renderReview, sampleTasks } from './review.js';

function task(index: number, mined = true): BenchTask {
  return {
    id: mined ? `m-${String(index).padStart(7, '0')}` : `h-${String(index).padStart(2, '0')}`,
    source: mined ? 'mined' : 'hand',
    ...(mined ? { commit: String(index).padStart(40, '0') } : {}),
    text: `Improve behavior ${index}.`, type: 'impact', groundTruth: { files: [`src/${index}.ts`], symbols: [] },
    split: 'test', e2e: false,
  };
}

describe('benchmark task review', () => {
  it('samples without replacement and caps at corpus size', () => {
    const tasks = [task(1), task(2), task(3)];
    const selected = sampleTasks(tasks, 20, () => 0.5);
    expect(selected).toHaveLength(3);
    expect(new Set(selected.map((value) => value.id)).size).toBe(3);
  });

  it('prints review fields, commit messages, and rejection instructions', async () => {
    const output = await renderReview([task(1), task(2, false)], async () => 'Fix account flow');
    expect(output).toContain('Text: Improve behavior 1.');
    expect(output).toContain('Ground truth files: src/1.ts');
    expect(output).toContain('Fix account flow');
    expect(output).toContain('(hand-authored task)');
    expect(output).toContain('bench/tasks/rejected.txt');
  });
});
