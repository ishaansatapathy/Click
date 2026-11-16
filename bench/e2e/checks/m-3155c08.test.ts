import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('long sidebar titles', () => {
  it('wraps titles in the reusable ellipsis treatment', () => {
    const path = ['src/layouts/components/Sidebar/Item.vue', 'src/layouts/components/Sidebar/SidebarItem.vue'].find(existsSync);
    expect(path).toBeTruthy();
    const source = readFileSync(path!, 'utf8');
    expect(source).toContain('class="title"');
    expect(source).toMatch(/\.title\s*\{\s*@extend\s+%ellipsis;/);
  });
});
