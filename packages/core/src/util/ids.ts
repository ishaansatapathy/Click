import { posix } from 'node:path';
import type { EdgeKind } from '../types.js';

// SPEC §2.1. Paths are posix, repo-relative, no leading "./", case preserved.

export class PathOutsideRootError extends Error {
  constructor(
    readonly root: string,
    readonly input: string,
  ) {
    super(`path escapes repo root: ${input}`);
    this.name = 'PathOutsideRootError';
  }
}

const toPosix = (p: string): string => p.replace(/\\/g, '/');
const isWinDrive = (p: string): boolean => /^[A-Za-z]:\//.test(p);
const isAbs = (p: string): boolean => isWinDrive(p) || p.startsWith('/');

/** Normalise any path (Windows or posix, absolute or relative) to a repo-relative posix path. Throws if it leaves root. */
export function normPath(root: string, p: string): string {
  const r = posix.normalize(toPosix(root)).replace(/\/+$/, '');
  let rel = toPosix(p);

  if (isAbs(rel)) {
    const abs = posix.normalize(rel);
    const ci = isWinDrive(r) || isWinDrive(abs); // Windows paths compare case-insensitively
    const a = ci ? abs.toLowerCase() : abs;
    const b = ci ? r.toLowerCase() : r;
    if (a !== b && !a.startsWith(b + '/')) throw new PathOutsideRootError(root, p);
    rel = abs.slice(r.length).replace(/^\/+/, ''); // slice the original so case is preserved
  }

  const out = posix.normalize(rel === '' ? '.' : rel).replace(/\/+$/, '');
  if (out === '..' || out.startsWith('../') || isAbs(out)) throw new PathOutsideRootError(root, p);
  return out === '' ? '.' : out;
}

export const fileId = (path: string): string => `file:${path}`;
export const symId = (path: string, name: string): string => `sym:${path}#${name}`;
export const routeId = (fullPath: string): string => `route:${fullPath}`;
export const chunkId = (path: string, symbol: string, n: number): string => `chunk:${path}#${symbol}#${n}`;
export const convId = (slug: string): string => `conv:${slug}`;

export type ParsedId =
  | { kind: 'file'; path: string }
  | { kind: 'sym'; path: string; name: string }
  | { kind: 'route'; fullPath: string }
  | { kind: 'chunk'; path: string; symbol: string; n: number }
  | { kind: 'conv'; slug: string };

/** Inverse of the id builders. Returns null for anything that isn't a well-formed id. */
export function parseId(id: string): ParsedId | null {
  const colon = id.indexOf(':');
  if (colon < 0) return null;
  const tag = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  switch (tag) {
    case 'file':
      return rest ? { kind: 'file', path: rest } : null;
    case 'route':
      return rest ? { kind: 'route', fullPath: rest } : null;
    case 'conv':
      return rest ? { kind: 'conv', slug: rest } : null;
    case 'sym': {
      const i = rest.lastIndexOf('#');
      return i > 0 && i < rest.length - 1 ? { kind: 'sym', path: rest.slice(0, i), name: rest.slice(i + 1) } : null;
    }
    case 'chunk': {
      const j = rest.lastIndexOf('#');
      const i = j > 0 ? rest.lastIndexOf('#', j - 1) : -1;
      const n = Number(rest.slice(j + 1));
      if (i <= 0 || j - i < 2 || !Number.isInteger(n) || n < 0) return null;
      return { kind: 'chunk', path: rest.slice(0, i), symbol: rest.slice(i + 1, j), n };
    }
    default:
      return null;
  }
}

/** `<from>|<kind>|<to>`. The symmetric co_changed edge orders its endpoints so both directions share one key. */
export function edgeKey(from: string, kind: EdgeKind, to: string): string {
  const [a, b] = kind === 'co_changed' && to < from ? [to, from] : [from, to];
  return `${a}|${kind}|${b}`;
}

/** SFC component name: file basename in PascalCase (`order-summary.vue` becomes `OrderSummary`). */
export function componentName(path: string): string {
  const base = posix.basename(path).replace(/\.[^.]+$/, '');
  return base
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}
