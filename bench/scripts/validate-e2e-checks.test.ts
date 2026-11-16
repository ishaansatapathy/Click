import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { assertHistoricalOutcomes, assertRealLongPath, loadValidationCases, longWorktreePath, parseIds } from './validate-e2e-checks.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('validate E2E checks', () => {
  it('pairs checks with justified mined tasks and filters requested ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'click-validate-e2e-'));
    dirs.push(root);
    const tasks = join(root, 'tasks');
    const checks = join(root, 'checks');
    mkdirSync(tasks); mkdirSync(checks);
    writeFileSync(join(tasks, 'm-easy.json'), JSON.stringify({ text: 'Change one label.', parentCommit: 'a'.repeat(40), commit: 'b'.repeat(40), e2e: true }));
    writeFileSync(join(checks, 'm-easy.test.ts'), 'export {}');
    expect(loadValidationCases(tasks, checks, ['m-easy'])).toEqual([expect.objectContaining({ id: 'm-easy', text: 'Change one label.' })]);
    expect(() => loadValidationCases(tasks, checks, ['missing'])).toThrow(/not found/);
  });

  it('requires a real long path and parent-fail/fix-pass outcomes', () => {
    const path = longWorktreePath('C:\\Users\\IshaanSatapathy\\Desktop\\Cllick-wt\\a', 'm-easy', 'parent', '12345678');
    expect(path).not.toContain('~');
    expect(path.length).toBeGreaterThanOrEqual(100);
    expect(() => assertRealLongPath(path)).not.toThrow();
    expect(() => assertRealLongPath('C:\\Users\\ISHAAN~1\\short')).toThrow(/8\.3/);
    expect(() => assertHistoricalOutcomes('m-easy', 1, 0)).not.toThrow();
    expect(() => assertHistoricalOutcomes('m-easy', 0, 0)).toThrow(/parentCommit/);
    expect(() => assertHistoricalOutcomes('m-easy', 1, 1)).toThrow(/fix commit/);
  });

  it('parses only an optional comma-separated id list', () => {
    expect(parseIds([])).toEqual([]);
    expect(parseIds(['--ids', 'm-a,m-b'])).toEqual(['m-a', 'm-b']);
    expect(() => parseIds(['--ids'])).toThrow(/needs/);
    expect(() => parseIds(['extra'])).toThrow(/unknown/);
  });
});
