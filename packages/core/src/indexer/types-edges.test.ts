import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { symId } from '../util/ids.js';
import { discover } from './discover.js';
import { profileRepo } from './profile.js';
import { makeResolver, type Resolver } from './resolve.js';
import { extractTsImports } from './ts-imports.js';
import { parseTs } from './ts-parse.js';
import { extractTsSymbols } from './ts-symbols.js';
import { extractTypeEdges } from './types-edges.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');

let resolve: Resolver;
beforeAll(async () => {
  resolve = makeResolver(profileRepo(FIXTURE), new Set((await discover(FIXTURE)).allPaths));
});

function run(path: string, src: string) {
  const sf = parseTs(src, path);
  return extractTypeEdges({ path, resolve, imports: extractTsImports(sf), symbols: extractTsSymbols(sf) });
}
const refText = (r: { refs: { from: string; targetPath: string; targetName: string }[] }) =>
  r.refs.map((x) => `${x.from.split('#')[1]} -> ${x.targetPath}#${x.targetName}`);

describe('extractTypeEdges (PROMPTS 051)', () => {
  it('fixture: orderTotal(order: Order) refers to the imported type (type-only import included)', () => {
    const p = 'src/utils/money.ts';
    const r = run(p, readFileSync(join(FIXTURE, p), 'utf8'));
    expect(refText(r)).toEqual(['orderTotal -> src/types/order.ts#Order']);
    expect(r.refs[0]).toMatchObject({ from: symId(p, 'orderTotal'), kind: 'has_type' });
    expect(r.edges).toEqual([]);
  });

  it('same-file types become edges immediately; the symbol itself and unknown words are ignored', () => {
    const r = run('src/x.ts', `interface Props { a: string }
type Id = string
export function make(p: Props, id: Id): Props { return p }
export interface Props2 extends Props { b: Id }
export function plain(n: number): string { return String(n) }`);
    expect(r.edges.map((e) => `${e.from.split('#')[1]} -> ${e.to.split('#')[1]}`)).toEqual(['make -> Props', 'make -> Id', 'Props2 -> Props', 'Props2 -> Id']);
    expect(r.refs).toEqual([]);
  });

  it('values imported from the repo are also emitted (link keeps only real types)', () => {
    const r = run('src/x.ts', "import { formatPrice } from '@/utils/money'\nimport type { Order } from '@/types/order'\nexport function f(o: Order, fmt: typeof formatPrice): void {}\n");
    expect(refText(r)).toEqual(['f -> src/types/order.ts#Order', 'f -> src/utils/money.ts#formatPrice']);
  });

  it('external types (vue, pinia) produce nothing; methods use Class.method owners', () => {
    const r = run('src/x.ts', "import type { Ref } from 'vue'\nimport type { Order } from '@/types/order'\nexport class Cart { add(o: Order): Ref<number> { return null as never } }\n");
    expect(refText(r)).toEqual(['Cart.add -> src/types/order.ts#Order']);
  });

  it('deduplicates repeated mentions', () => {
    const r = run('src/x.ts', "import type { Order } from '@/types/order'\nexport function f(a: Order, b: Order[], c: Map<string, Order>): Order {}\n");
    expect(r.refs).toHaveLength(1);
  });
});
