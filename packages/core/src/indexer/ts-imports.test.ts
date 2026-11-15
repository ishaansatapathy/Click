import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractTsImports } from './ts-imports.js';
import { parseTs } from './ts-parse.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');

const SRC = `import Vue from 'vue';
import { ref, type Ref, computed as c } from 'vue';
import * as api from '@/api';
import type { Order } from '@/types/order';
import Def, { named } from './mod';
import './side-effect.css';
export { default as BaseButton } from './BaseButton.vue';
export * from './all';
export * as ns from './ns';
export type { T } from './types';
export { local };
const routes = [{ component: () => import('@/views/A.vue') }];
async function load() { const m = await import('./lazy'); return m; }
const notStatic = import(\`./x/\${name}\`);
`;

describe('extractTsImports (PROMPTS 043)', () => {
  const imports = extractTsImports(parseTs(SRC));

  it('captures static imports with every binding form and type-only flags', () => {
    expect(imports.slice(0, 6)).toEqual([
      { spec: 'vue', kind: 'static', line: 1, names: [{ imported: 'default', local: 'Vue', typeOnly: false }] },
      {
        spec: 'vue', kind: 'static', line: 2,
        names: [
          { imported: 'ref', local: 'ref', typeOnly: false },
          { imported: 'Ref', local: 'Ref', typeOnly: true },
          { imported: 'computed', local: 'c', typeOnly: false },
        ],
      },
      { spec: '@/api', kind: 'static', line: 3, names: [{ imported: '*', local: 'api', typeOnly: false }] },
      { spec: '@/types/order', kind: 'static', line: 4, names: [{ imported: 'Order', local: 'Order', typeOnly: true }] },
      {
        spec: './mod', kind: 'static', line: 5,
        names: [{ imported: 'default', local: 'Def', typeOnly: false }, { imported: 'named', local: 'named', typeOnly: false }],
      },
      { spec: './side-effect.css', kind: 'static', line: 6, names: [] },
    ]);
  });

  it('captures re-exports (barrels) but not local export lists', () => {
    expect(imports.filter((i) => i.kind === 'reexport')).toEqual([
      { spec: './BaseButton.vue', kind: 'reexport', line: 7, names: [{ imported: 'default', local: 'BaseButton', typeOnly: false }] },
      { spec: './all', kind: 'reexport', line: 8, names: [{ imported: '*', local: '*', typeOnly: false }] },
      { spec: './ns', kind: 'reexport', line: 9, names: [{ imported: '*', local: 'ns', typeOnly: false }] },
      { spec: './types', kind: 'reexport', line: 10, names: [{ imported: 'T', local: 'T', typeOnly: true }] },
    ]);
  });

  it('captures dynamic imports anywhere, skipping non-literal specifiers', () => {
    expect(imports.filter((i) => i.kind === 'dynamic')).toEqual([
      { spec: '@/views/A.vue', kind: 'dynamic', line: 12, names: [] },
      { spec: './lazy', kind: 'dynamic', line: 13, names: [] },
    ]);
  });

  it('applies lineOffset', () => {
    expect(extractTsImports(parseTs("import x from 'y';\n"), { lineOffset: 4 })[0]?.line).toBe(5);
  });

  it('fixture router: static imports plus the three lazy route components', () => {
    const r = extractTsImports(parseTs(readFileSync(join(FIXTURE, 'src/router/index.ts'), 'utf8')));
    expect(r.map((i) => `${i.kind}:${i.spec}`)).toEqual([
      'static:vue-router',
      'static:@/views/HomeView.vue',
      'dynamic:@/views/OrdersView.vue',
      'dynamic:@/views/OrderDetailView.vue',
      'dynamic:@/views/CheckoutView.vue',
    ]);
  });

  it('fixture barrel: re-exports of .vue defaults', () => {
    const r = extractTsImports(parseTs(readFileSync(join(FIXTURE, 'src/components/index.ts'), 'utf8')));
    expect(r.map((i) => [i.spec, i.names[0]?.local])).toEqual([
      ['./BaseButton.vue', 'BaseButton'],
      ['./CheckoutButton.vue', 'CheckoutButton'],
    ]);
  });
});
