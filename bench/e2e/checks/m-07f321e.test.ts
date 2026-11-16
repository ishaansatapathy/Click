import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('initial tags-view route', () => {
  it('asks the route listener for an immediate callback and avoids a duplicate mount add', () => {
    const source = readFileSync('src/layouts/components/TagsView/index.vue', 'utf8');
    expect(source).toMatch(/listenerRouteChange\(\(route\)\s*=>\s*\{\s*addTags\(route\)\s*\},\s*true\)/);
    const mounted = source.match(/onMounted\(\(\)\s*=>\s*\{([\s\S]*?)\}\)/)?.[1] ?? '';
    expect(mounted).not.toContain('addTags(route)');
  });
});
