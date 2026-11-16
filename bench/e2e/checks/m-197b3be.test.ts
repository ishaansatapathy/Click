import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('sidebar text selection', () => {
  it('prevents selecting menu text during navigation interactions', () => {
    const source = readFileSync('src/layouts/components/Sidebar/index.vue', 'utf8');
    expect(source).toMatch(/\.el-menu\s*\{[\s\S]*?user-select:\s*none;/);
  });
});
