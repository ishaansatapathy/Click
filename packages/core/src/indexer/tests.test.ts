import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { discover } from './discover.js';
import { profileRepo } from './profile.js';
import { makeResolver, type Resolver } from './resolve.js';
import { extractTestFile } from './tests.js';
import { extractTsImports } from './ts-imports.js';
import { parseTs } from './ts-parse.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');

let resolve: Resolver;
beforeAll(async () => {
  resolve = makeResolver(profileRepo(FIXTURE), new Set((await discover(FIXTURE)).allPaths));
});

const info = (path: string, src: string) => {
  const sf = parseTs(src, path);
  return extractTestFile(sf, path, extractTsImports(sf), resolve);
};

describe('extractTestFile (PROMPTS 052)', () => {
  it('fixture spec: node id, describe titles, case count and tested_by refs for what it imports', () => {
    const p = 'tests/checkout.spec.ts';
    const t = info(p, readFileSync(join(FIXTURE, p), 'utf8'));
    expect(t.nodeId).toBe('sym:tests/checkout.spec.ts#checkout.spec.ts');
    expect(t.describes).toEqual(['CheckoutButton']);
    expect(t.cases).toBe(1);
    expect(t.signature).toBe('test file checkout.spec.ts: describe "CheckoutButton" (1 case)');
    expect(t.refs.map((r) => `${r.targetPath}#${r.targetName}`)).toEqual([
      'src/components/CheckoutButton.vue#default',
      'src/stores/order.ts#useOrderStore',
    ]);
    expect(t.refs.every((r) => r.kind === 'tested_by' && r.from === t.nodeId)).toBe(true);
  });

  it('namespace and side-effect imports point at the whole file; type-only and external imports are ignored', () => {
    const t = info(
      'tests/x.test.ts',
      `import * as money from '@/utils/money'
import '@/stores/cart'
import type { Order } from '@/types/order'
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'`,
    );
    expect(t.refs.map((r) => `${r.targetPath}#${r.targetName}`)).toEqual(['src/utils/money.ts#*', 'src/stores/cart.ts#*']);
  });

  it('counts describe.only / it.skip variants and nested describes, ignores non-literal titles', () => {
    const t = info(
      'tests/y.test.ts',
      `describe('outer', () => {
  describe.only('inner', () => { it('a', () => {}); it.skip('b', () => {}); test('c', () => {}) })
  it(\`\${name}\`, () => {})
  it('d', () => {})
})`,
    );
    expect(t.describes).toEqual(['outer', 'inner']);
    expect(t.cases).toBe(4);
    expect(t.signature).toBe('test file y.test.ts: describe "outer", "inner" (4 cases)');
  });

  it('a file with no tests still yields a node and refs', () => {
    const t = info('tests/setup.ts', "import '@/stores/order'\n");
    expect(t.describes).toEqual([]);
    expect(t.refs).toHaveLength(1);
    expect(t.signature).toBe('test file setup.ts (0 cases)');
  });
});
