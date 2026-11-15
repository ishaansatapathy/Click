import { describe, expect, it } from 'vitest';

import type { TaskTextRecord } from './write-task-text.js';
import { gateTasks, memoizeRepo } from './gate-g1a.js';

function record(index: number, files = ['src/a.ts']): TaskTextRecord {
  const sha = index.toString(16).padStart(40, '0');
  return {
    sha, date: '2025-01-01T00:00:00Z', authorName: 'Dev', authorEmail: 'dev@example.com',
    message: 'Improve behavior', files: [], groundTruthFiles: files, changedLines: 1, text: 'Improve the behavior.',
    taskText: { provider: 'openai', model: 'gpt-6-luna', promptVersion: 'v1', inputTokens: 1, outputTokens: 1 },
  };
}

describe('G1a task view', () => {
  it('excludes rejected SHAs and maps accepted records without persisting provisional tasks', () => {
    const first = record(1);
    const second = record(2, ['src/a.ts', 'src/b.ts']);
    const tasks = gateTasks([first, second], new Set([first.sha]));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: `m-${second.sha.slice(0, 7)}`, source: 'mined', type: 'multi-file',
      groundTruth: { files: ['src/a.ts', 'src/b.ts'], symbols: [] },
    });
  });

  it('memoizes source listings and file bodies across runs', async () => {
    let lists = 0;
    let reads = 0;
    const repo = memoizeRepo({
      async listSourceFiles() { lists++; return ['src/a.ts']; },
      async readFile() { reads++; return 'body'; },
    });
    await Promise.all([repo.listSourceFiles(), repo.listSourceFiles(), repo.readFile('src/a.ts'), repo.readFile('src/a.ts')]);
    expect({ lists, reads }).toEqual({ lists: 1, reads: 1 });
  });
});
