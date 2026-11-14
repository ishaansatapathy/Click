import { getEncoding, type Tiktoken } from 'js-tiktoken';
import { sha1 } from './hash.js';

// SPEC §9.4: cl100k_base is a PROXY for the real model tokenizer. It is used identically for every
// variant, so comparisons are fair. Real model token counts appear only in E2E results.

let enc: Tiktoken | null = null;
const encoder = (): Tiktoken => (enc ??= getEncoding('cl100k_base'));

const MEMO_MIN_CHARS = 2048;
const MEMO_MAX_ENTRIES = 500;
const memo = new Map<string, number>(); // insertion order doubles as LRU order

/** Token count of `text` under the proxy tokenizer. Special-token strings are counted as plain text. */
export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  if (text.length < MEMO_MIN_CHARS) return encode(text);

  const key = sha1(text);
  const hit = memo.get(key);
  if (hit !== undefined) {
    memo.delete(key);
    memo.set(key, hit); // refresh recency
    return hit;
  }
  const n = encode(text);
  memo.set(key, n);
  if (memo.size > MEMO_MAX_ENTRIES) memo.delete(memo.keys().next().value as string);
  return n;
}

export function fits(tokens: number, budget: number): boolean {
  return tokens <= budget;
}

function encode(text: string): number {
  // Empty allow/disallow lists: code containing "<|endoftext|>" must be counted, not throw.
  return encoder().encode(text, [], []).length;
}

/** Test hook: size of the memo cache. */
export function _memoSize(): number {
  return memo.size;
}
