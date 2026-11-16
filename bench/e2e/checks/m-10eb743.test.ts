import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('mobile sidebar stacking', () => {
  it('keeps the drawer below the sidebar and both above the loading overlay', () => {
    const source = readFileSync('src/layouts/modes/LeftMode.vue', 'utf8');
    expect(source).toMatch(/\.drawer-bg\s*\{[\s\S]*?z-index:\s*2001;/);
    expect(source).toMatch(/\.sidebar-container\s*\{[\s\S]*?z-index:\s*2002;/);
  });
});
