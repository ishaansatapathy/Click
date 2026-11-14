import { describe, expect, it } from 'vitest';
import { _memoSize, countTokens, fits } from './tokens.js';

describe('countTokens', () => {
  it('counts known cl100k_base values', () => {
    expect(countTokens('')).toBe(0);
    expect(countTokens('hello world')).toBe(2);
    expect(countTokens('Hello, world!')).toBe(4);
  });
  it('counts code and unicode without throwing', () => {
    expect(countTokens('export const useOrderStore = defineStore("order", () => {})')).toBeGreaterThan(8);
    expect(countTokens('héllo 世界 🚀')).toBeGreaterThan(0);
  });
  it('treats special-token text as plain text instead of throwing', () => {
    expect(() => countTokens('const s = "<|endoftext|>";')).not.toThrow();
    expect(countTokens('<|endoftext|>')).toBeGreaterThan(1);
  });
  it('memoises long strings and returns the same count', () => {
    const before = _memoSize();
    const long = 'const value = computeSomething(a, b, c);\n'.repeat(100); // > 2 KB
    const first = countTokens(long);
    expect(_memoSize()).toBe(before + 1);
    expect(countTokens(long)).toBe(first);
    expect(_memoSize()).toBe(before + 1);
  });
  it('does not memoise short strings', () => {
    const before = _memoSize();
    countTokens('short string ' + Math.random());
    expect(_memoSize()).toBe(before);
  });
  it('bounds the memo cache', () => {
    for (let i = 0; i < 520; i++) countTokens(`${i} `.repeat(1200));
    expect(_memoSize()).toBeLessThanOrEqual(500);
  });
});

describe('fits', () => {
  it('is inclusive of the budget', () => {
    expect(fits(4000, 4000)).toBe(true);
    expect(fits(4001, 4000)).toBe(false);
  });
});
