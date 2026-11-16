import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('mixed layout header bounds', () => {
  it('keeps the logo width fixed and clips overflowing header content', () => {
    const path = ['src/layouts/modes/LeftTopMode.vue', 'src/layouts/LeftTopMode.vue'].find(existsSync);
    expect(path).toBeTruthy();
    const source = readFileSync(path!, 'utf8');
    expect(source).toMatch(/\.logo\s*\{\s*flex:\s*none;[\s\S]*?width:\s*var\(--v3-sidebar-width\);/);
    expect(source).toMatch(/\.content\s*\{[\s\S]*?overflow:\s*hidden;/);
  });
});
