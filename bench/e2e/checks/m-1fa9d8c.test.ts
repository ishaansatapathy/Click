import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('logout menu markup', () => {
  it('renders the label directly without a redundant span', () => {
    const source = readFileSync('src/layouts/components/NavigationBar/index.vue', 'utf8');
    expect(source).toMatch(/<el-dropdown-item\s+divided\s+@click="logout">\s*退出登录\s*<\/el-dropdown-item>/);
    expect(source).not.toContain('<span style="display: block">退出登录</span>');
  });
});
