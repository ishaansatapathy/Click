import { describe, expect, it, vi } from 'vitest';

import type { TaskTextRecord } from './write-task-text.js';
import { checkLeaks, findLeaks, forbiddenTerms, stricterSystemPrompt } from './leak-check.js';

function record(text: string, sha = 'a'.repeat(40)): TaskTextRecord {
  return {
    sha,
    date: '2025-01-01T00:00:00Z',
    authorName: 'Developer',
    authorEmail: 'dev@example.com',
    message: 'Improve profile loading',
    files: [],
    groundTruthFiles: ['src/views/user-profile/UserSettingsPanel.vue'],
    changedLines: 3,
    text,
    taskText: { model: 'model', promptVersion: 'v1', inputTokens: 1, outputTokens: 1 },
  };
}

describe('leak detection', () => {
  it('derives path, basename, PascalCase, and kebab-case terms', () => {
    const terms = forbiddenTerms(record('').groundTruthFiles);
    expect(terms).toEqual(expect.arrayContaining([
      'src', 'views', 'user-profile', 'UserSettingsPanel.vue', 'UserSettingsPanel', 'user-settings-panel',
    ]));
  });

  it('matches leaks case-insensitively', () => {
    expect(findLeaks(record('Please make USER-SETTINGS-PANEL easier to use.'))).toContain('user-settings-panel');
    expect(findLeaks(record('Please make account preferences easier to use.'))).toEqual([]);
  });

  it('regenerates leaking text once and rejects only persistent leaks', async () => {
    const clean = record('Improve the account preferences experience.', 'b'.repeat(40));
    const fixed = record('Please update UserSettingsPanel behavior.', 'c'.repeat(40));
    const persistent = record('Please update UserSettingsPanel behavior.', 'd'.repeat(40));
    const regenerate = vi.fn(async (value: TaskTextRecord) => value.sha === fixed.sha
      ? { ...value, text: 'Improve the account preferences experience.' }
      : value);
    const result = await checkLeaks([clean, fixed, persistent], regenerate);

    expect(regenerate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ before: 2, after: 1, rejectedShas: [persistent.sha] });
    expect(result.records[1]?.text).toBe('Improve the account preferences experience.');
  });

  it('makes the retry prohibition explicit', () => {
    expect(stricterSystemPrompt(['UserSettingsPanel'])).toContain('Do not use any of these strings');
  });
});
