import { describe, expect, it } from 'vitest';
import { hashOf, sha1, stableStringify } from './hash.js';

describe('sha1', () => {
  it('matches known vectors', () => {
    expect(sha1('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(sha1('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });
});

describe('stableStringify', () => {
  it('is independent of key order, at every depth', () => {
    const a = { b: 1, a: { y: [1, { q: 1, p: 2 }], x: 'k' } };
    const b = { a: { x: 'k', y: [1, { p: 2, q: 1 }] }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify(a)).toBe('{"a":{"x":"k","y":[1,{"p":2,"q":1}]},"b":1}');
  });
  it('has no whitespace and keeps array order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });
  it('follows JSON.stringify for undefined, NaN and toJSON', () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableStringify([undefined, () => 1])).toBe('[null,null]');
    expect(stableStringify({ n: NaN })).toBe('{"n":null}');
    expect(stableStringify({ d: new Date(0) })).toBe('{"d":"1970-01-01T00:00:00.000Z"}');
    expect(stableStringify(undefined)).toBe('null');
  });
  it('escapes keys and strings safely', () => {
    expect(stableStringify({ 'a"b': 'c\n' })).toBe('{"a\\"b":"c\\n"}');
  });
  it('throws on cycles but allows shared (non-circular) references', () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => stableStringify(cyc)).toThrow(/circular/);
    const shared = { v: 1 };
    expect(stableStringify({ a: shared, b: shared })).toBe('{"a":{"v":1},"b":{"v":1}}');
  });
  it('throws on bigint', () => {
    expect(() => stableStringify({ n: 1n })).toThrow(/bigint/);
  });
});

describe('hashOf', () => {
  it('is 12 hex chars, key-order independent and stable', () => {
    const h = hashOf({ a: 1, b: [1, 2] });
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(hashOf({ b: [1, 2], a: 1 })).toBe(h);
    expect(h).toBe(sha1('{"a":1,"b":[1,2]}').slice(0, 12)); // stable across runs and machines
    expect(hashOf({ a: 2, b: [1, 2] })).not.toBe(h);
  });
});
