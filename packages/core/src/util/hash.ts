import { createHash } from 'node:crypto';

export function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/**
 * JSON-like serialisation with sorted object keys and no whitespace, so the same value always
 * produces the same string regardless of key insertion order.
 * Matches JSON.stringify for primitives: undefined/functions are dropped from objects and become
 * null in arrays; NaN and Infinity become null. Throws on cycles and bigint.
 */
export function stableStringify(value: unknown): string {
  return stringify(value, new Set<object>()) ?? 'null';
}

function stringify(value: unknown, seen: Set<object>): string | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value === 'bigint') throw new TypeError('stableStringify: bigint is not supported');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);

  const toJSON = (value as { toJSON?: () => unknown }).toJSON;
  if (typeof toJSON === 'function') return stringify(toJSON.call(value), seen);

  if (seen.has(value)) throw new TypeError('stableStringify: circular structure');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((v) => stringify(v, seen) ?? 'null').join(',')}]`;
    }
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const s = stringify((value as Record<string, unknown>)[key], seen);
      if (s !== undefined) parts.push(`${JSON.stringify(key)}:${s}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/** First 12 hex chars of sha1(stableStringify(obj)). Used for config hashes, graph versions and cache keys. */
export function hashOf(obj: unknown): string {
  return sha1(stableStringify(obj)).slice(0, 12);
}
