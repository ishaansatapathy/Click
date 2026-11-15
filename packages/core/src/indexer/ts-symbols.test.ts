import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseTs } from './ts-parse.js';
import { MAX_SIGNATURE, extractTsSymbols, type TsSymbol } from './ts-symbols.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');
const fixture = (rel: string) => readFileSync(join(FIXTURE, rel), 'utf8').replace(/\r\n/g, '\n');

const SRC = `/**
 * Format an amount.
 * More text.
 */
export function formatPrice(minor: number, currency = 'INR'): string {
  return String(minor);
}
function helper() { return 1 }
const local = 5;
const arrowHelper = (a: number) => a * 2;
export const useFormat = () => {
  return {};
};
export const useOrderStore = defineStore('order', () => {
  const x = 1;
  return { x };
});
export const routes: RouteRecordRaw[] = [
  { path: '/' },
];
export const REDIRECT = "/redirect";
export interface Order { id: string }
export type Status = 'a' | 'b';
export enum Mode { A, B }
export class Cart extends Base {
  /** Add an item. */
  add(item: Item): void { this.items.push(item); }
  get count(): number { return 1; }
  private secret = 1;
}
export function over(a: string): string;
export function over(a: number): number;
export function over(a: unknown) { return a; }
const later = () => 1;
export { later, local as renamed };
export default defineComponent({ name: 'X' });
`;

const lineOfText = (text: string, needle: string): number => text.slice(0, text.indexOf(needle)).split('\n').length;
const byName = (syms: TsSymbol[], name: string): TsSymbol => {
  const s = syms.find((x) => x.name === name);
  if (!s) throw new Error(`no symbol ${name}; have ${syms.map((x) => x.name).join(', ')}`);
  return s;
};

describe('extractTsSymbols (SPEC §5.3)', () => {
  const syms = extractTsSymbols(parseTs(SRC));

  it('finds exactly the expected symbols, sorted by line', () => {
    expect(syms.map((s) => s.name)).toEqual([
      'formatPrice', 'helper', 'local', 'arrowHelper', 'useFormat', 'useOrderStore', 'routes', 'REDIRECT',
      'Order', 'Status', 'Mode', 'Cart', 'Cart.add', 'Cart.count', 'over', 'later', 'default',
    ]);
  });

  it('function: range includes the JSDoc, signature drops the body, doc is the first line', () => {
    const s = byName(syms, 'formatPrice');
    expect(s).toMatchObject({ kind: 'function', exported: true, isDefault: false, doc: 'Format an amount.' });
    expect(s.range).toEqual({ startLine: 1, endLine: lineOfText(SRC, "  return String(minor);") + 1 });
    expect(s.signature).toBe("export function formatPrice(minor: number, currency = 'INR'): string { … }");
  });

  it('non-exported functions and arrow helpers are kept; plain non-exported values are not', () => {
    expect(byName(syms, 'helper')).toMatchObject({ kind: 'function', exported: false });
    expect(byName(syms, 'arrowHelper')).toMatchObject({ kind: 'function', exported: false, initializer: 'arrow', signature: 'const arrowHelper = (a: number) => …' });
  });

  it('a local named in `export { … }` counts as exported', () => {
    expect(byName(syms, 'local')).toMatchObject({ kind: 'const', exported: true, signature: 'const local = 5' });
    expect(byName(syms, 'later')).toMatchObject({ kind: 'function', exported: true });
  });

  it('variables: arrow functions, store calls, arrays and literals get compact signatures', () => {
    expect(byName(syms, 'useFormat')).toMatchObject({ kind: 'function', signature: 'export const useFormat = () => { … }' });
    const store = byName(syms, 'useOrderStore');
    expect(store).toMatchObject({ kind: 'const', initializer: 'call', callee: 'defineStore', signature: "export const useOrderStore = defineStore('order', …)" });
    expect(store.range).toEqual({ startLine: lineOfText(SRC, 'export const useOrderStore'), endLine: lineOfText(SRC, 'export const routes') - 1 });
    expect(byName(syms, 'routes').signature).toBe('export const routes: RouteRecordRaw[] = [ … ]');
    expect(byName(syms, 'REDIRECT').signature).toBe('export const REDIRECT = "/redirect"');
  });

  it('interfaces, types and enums keep their full (short) text', () => {
    expect(byName(syms, 'Order')).toMatchObject({ kind: 'interface', signature: 'export interface Order { id: string }' });
    expect(byName(syms, 'Status')).toMatchObject({ kind: 'type', signature: "export type Status = 'a' | 'b';" });
    expect(byName(syms, 'Mode')).toMatchObject({ kind: 'enum', signature: 'export enum Mode { A, B }' });
  });

  it('classes: header signature plus methods and accessors as Class.member', () => {
    expect(byName(syms, 'Cart')).toMatchObject({ kind: 'class', signature: 'export class Cart extends Base { … }' });
    expect(byName(syms, 'Cart.add')).toMatchObject({ kind: 'method', parent: 'Cart', doc: 'Add an item.', signature: 'add(item: Item): void { … }' });
    expect(byName(syms, 'Cart.count')).toMatchObject({ kind: 'method', signature: 'get count(): number { … }' });
    expect(syms.some((s) => s.name === 'Cart.secret')).toBe(false);
  });

  it('overloads merge into one symbol spanning every declaration', () => {
    const over = syms.filter((s) => s.name === 'over');
    expect(over).toHaveLength(1);
    expect(over[0]!.range).toEqual({ startLine: lineOfText(SRC, 'export function over(a: string)'), endLine: lineOfText(SRC, 'export function over(a: unknown)') });
    expect(over[0]!.signature).toBe('export function over(a: string): string;');
  });

  it('export default <call> becomes a "default" symbol with its callee', () => {
    expect(byName(syms, 'default')).toMatchObject({ kind: 'const', isDefault: true, callee: 'defineComponent', signature: 'export default defineComponent({ … })' });
  });

  it('export default <identifier> marks the local instead of adding a symbol', () => {
    const s = extractTsSymbols(parseTs('function setup() {}\nexport default setup;\n'));
    expect(s.map((x) => [x.name, x.isDefault, x.exported])).toEqual([['setup', true, true]]);
  });

  it('applies lineOffset for embedded script blocks', () => {
    const s = extractTsSymbols(parseTs('const a = () => 1;\n'), { lineOffset: 10 });
    expect(s[0]!.range).toEqual({ startLine: 11, endLine: 11 });
  });

  it('caps signatures at 300 characters', () => {
    const params = Array.from({ length: 40 }, (_, i) => `parameterNumber${i}: string`).join(', ');
    const s = extractTsSymbols(parseTs(`export function huge(${params}) {}\n`));
    expect(s[0]!.signature.length).toBe(MAX_SIGNATURE);
    expect(s[0]!.signature.endsWith('…')).toBe(true);
  });

  it('parses JS and TSX without throwing', () => {
    expect(extractTsSymbols(parseTs('export function a(x) { return x }', 'a.js'))[0]?.name).toBe('a');
    expect(extractTsSymbols(parseTs('export const C = () => <div/>;', 'c.tsx'))[0]?.name).toBe('C');
  });
});

describe('extractTsSymbols on the fixture repo', () => {
  it('stores: setup-style and options-style both surface as defineStore consts', () => {
    const order = extractTsSymbols(parseTs(fixture('src/stores/order.ts')));
    expect(byName(order, 'useOrderStore')).toMatchObject({ kind: 'const', callee: 'defineStore', exported: true });
    const cart = extractTsSymbols(parseTs(fixture('src/stores/cart.ts')));
    expect(byName(cart, 'useCartStore')).toMatchObject({ callee: 'defineStore', signature: 'export const useCartStore = defineStore({ … })' });
  });

  it('composables: function declarations and exported arrows, with docs', () => {
    expect(byName(extractTsSymbols(parseTs(fixture('src/composables/useSubmit.ts'))), 'useSubmit').doc).toBe(
      'Wrap an async action with an in-flight flag, so buttons can show a loading state.',
    );
    expect(byName(extractTsSymbols(parseTs(fixture('src/composables/useFormat.ts'))), 'useFormat').kind).toBe('function');
  });

  it('router: route table and router instance', () => {
    const r = extractTsSymbols(parseTs(fixture('src/router/index.ts')));
    expect(byName(r, 'routes')).toMatchObject({ initializer: 'array' });
    expect(byName(r, 'router')).toMatchObject({ callee: 'createRouter', signature: 'export const router = createRouter({ … })' });
  });
});
