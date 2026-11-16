import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('collapsed sidebar active parent', () => {
  it('uses the menu hover background for the active parent title', () => {
    const source = readFileSync('src/layouts/components/Sidebar/index.vue', 'utf8');
    expect(source).toMatch(/\.el-menu--collapse\s*\{[\s\S]*?\.el-sub-menu\.is-active[\s\S]*?background-color:\s*v-bind\(sidebarMenuHoverBgColor\);/);
  });
});
