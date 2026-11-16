import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('sidebar group expansion', () => {
  it('does not force the menu to keep only one group open', () => {
    const source = readFileSync('src/layouts/components/Sidebar/index.vue', 'utf8');
    expect(source).not.toMatch(/:?unique-opened\s*=/);
  });
});
