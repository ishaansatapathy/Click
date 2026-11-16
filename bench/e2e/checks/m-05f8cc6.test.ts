import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('footer setting label', () => {
  it('removes the redundant English word without changing the binding', () => {
    const source = readFileSync('src/layouts/components/Settings/index.vue', 'utf8');
    expect(source).toContain('"显示页脚": showFooter');
    expect(source).not.toContain('"显示页脚 Footer"');
  });
});
