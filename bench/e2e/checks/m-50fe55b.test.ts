import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('navigation right item alignment', () => {
  it('gives right-menu items the height needed for vertical centering', () => {
    const source = readFileSync('src/layouts/components/NavigationBar/index.vue', 'utf8');
    expect(source).toMatch(/&-item\s*\{\s*height:\s*20px;/);
  });
});
