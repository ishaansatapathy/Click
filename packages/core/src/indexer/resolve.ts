// SPEC §5.2: resolve an import specifier to a repo file, an external package, or "unresolved".
// Pure: resolution checks a set of known repo paths instead of the disk, so it is fast, deterministic and testable.
// Never throws: unresolvable specs are counted by the indexer (G1 gate: < 2% of local imports).

import { posix } from 'node:path';
import type { RepoProfile, Resolved } from '../contracts.js';

/** Extension probing order (SPEC §5.2). */
export const PROBE_EXTS = ['.ts', '.tsx', '.vue', '.js'] as const;
const INDEX_FILES = ['index.ts', 'index.js'] as const;
/** TS ESM style: `import './x.js'` refers to x.ts. */
const JS_TO_TS: Record<string, readonly string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'] };

export type ResolverProfile = Pick<RepoProfile, 'tsconfigPaths' | 'baseUrl' | 'viteAliases'>;
export type Resolver = (spec: string, fromPath: string) => Resolved;

interface PathPattern {
  key: string;
  prefix: string;
  suffix: string;
  wildcard: boolean;
  targets: string[];
}

function compilePaths(paths: Record<string, string[]>): PathPattern[] {
  return Object.entries(paths).map(([key, targets]) => {
    const star = key.indexOf('*');
    return star < 0
      ? { key, prefix: key, suffix: '', wildcard: false, targets }
      : { key, prefix: key.slice(0, star), suffix: key.slice(star + 1), wildcard: true, targets };
  });
}

/** TypeScript's rule: an exact (non-wildcard) key wins; otherwise the pattern with the longest prefix. */
function matchPaths(patterns: PathPattern[], spec: string): string[] | null {
  const exact = patterns.find((p) => !p.wildcard && p.key === spec);
  if (exact) return exact.targets;
  let best: PathPattern | null = null;
  for (const p of patterns) {
    if (!p.wildcard || !spec.startsWith(p.prefix) || !spec.endsWith(p.suffix)) continue;
    if (spec.length < p.prefix.length + p.suffix.length) continue;
    if (!best || p.prefix.length > best.prefix.length) best = p;
  }
  if (!best) return null;
  const captured = spec.slice(best.prefix.length, spec.length - best.suffix.length);
  return best.targets.map((t) => t.replace('*', captured));
}

const SCOPED_PKG = /^@[a-z0-9~-][a-z0-9._~-]*\/[a-z0-9~-][a-z0-9._~-]*/i;
const PLAIN_PKG = /^[a-z0-9][a-z0-9._~-]*$/i;

/** Package name for a bare specifier, or null when the spec can't be a package (e.g. an unmatched '@/x' alias). */
export function packageName(spec: string): string | null {
  if (spec.startsWith('node:') || spec.startsWith('virtual:') || spec.startsWith('~virtual/')) return spec; // Vite virtual modules
  if (spec.startsWith('@')) {
    const m = SCOPED_PKG.exec(spec);
    return m ? m[0] : null;
  }
  const first = spec.split('/')[0] ?? '';
  return PLAIN_PKG.test(first) ? first : null;
}

export function makeResolver(profile: ResolverProfile, files: ReadonlySet<string>): Resolver {
  const patterns = compilePaths(profile.tsconfigPaths ?? {});
  // Longest alias first, so '@@' is tried before '@'.
  const aliases = Object.entries(profile.viteAliases ?? {}).sort((a, b) => b[0].length - a[0].length);
  const baseUrl = profile.baseUrl;
  const bareCache = new Map<string, Resolved>(); // non-relative specs resolve the same from every file

  /** First existing file for a repo-relative base path, following SPEC §5.2 probing. */
  function probe(base: string): string | null {
    let p = posix.normalize(base).replace(/\/+$/, '');
    if (p.startsWith('./')) p = p.slice(2);
    if (p === '' || p === '.' || p === '..' || p.startsWith('../') || p.startsWith('/')) return null;
    if (files.has(p)) return p;
    const ext = posix.extname(p);
    for (const alt of JS_TO_TS[ext] ?? []) {
      const swapped = p.slice(0, -ext.length) + alt;
      if (files.has(swapped)) return swapped;
    }
    for (const e of PROBE_EXTS) if (files.has(p + e)) return p + e;
    for (const idx of INDEX_FILES) if (files.has(`${p}/${idx}`)) return `${p}/${idx}`;
    return null;
  }

  const local = (path: string | null, spec: string): Resolved => (path ? { kind: 'local', path } : { kind: 'unresolved', spec });

  function resolveBare(spec: string): Resolved {
    // Vite root-absolute import: '/src/main.ts'.
    if (spec.startsWith('/')) return local(probe(spec.slice(1)), spec);

    const targets = matchPaths(patterns, spec);
    if (targets) {
      for (const t of targets) {
        const hit = probe(t);
        if (hit) return { kind: 'local', path: hit };
      }
    }
    for (const [key, target] of aliases) {
      if (spec === key || spec.startsWith(`${key}/`)) {
        const hit = probe(target + spec.slice(key.length));
        if (hit) return { kind: 'local', path: hit };
        return { kind: 'unresolved', spec }; // an alias matched, so this was meant to be local
      }
    }
    if (targets) return { kind: 'unresolved', spec };

    if (baseUrl !== null && baseUrl !== undefined) {
      const hit = probe(posix.join(baseUrl, spec));
      if (hit) return { kind: 'local', path: hit };
    }
    const pkg = packageName(spec);
    return pkg ? { kind: 'external', pkg } : { kind: 'unresolved', spec };
  }

  return (rawSpec, fromPath) => {
    try {
      const spec = rawSpec.split('?')[0]!.trim(); // '?raw', '?url', '?inline' and friends
      if (spec === '') return { kind: 'unresolved', spec: rawSpec };
      if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
        return local(probe(posix.join(posix.dirname(fromPath), spec)), rawSpec);
      }
      let hit = bareCache.get(spec);
      if (!hit) {
        hit = resolveBare(spec);
        bareCache.set(spec, hit);
      }
      return hit.kind === 'unresolved' ? { kind: 'unresolved', spec: rawSpec } : hit;
    } catch {
      return { kind: 'unresolved', spec: rawSpec };
    }
  };
}
