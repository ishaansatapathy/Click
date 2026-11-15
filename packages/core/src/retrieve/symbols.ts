// PROMPTS 086: symbol seeds. The task text often names things outright ("fix `useOrderStore`", "the <order-summary>
// tag", "in checkout.vue"). Pull those identifiers out of the text and match them against node names, file basenames
// and paths. Scores: exact 1.0, case-insensitive 0.7, prefix 0.5 (a node's best score over all identifiers wins).
// Plain lowercase prose words are NOT identifiers here: that is BM25's job.

import type { ScoredId } from '../store/types.js';
import type { Graph, GraphNode } from '../types.js';

export const SYMBOL_SCORES = { exact: 1, caseInsensitive: 0.7, prefix: 0.5 } as const;
const MIN_PREFIX_LEN = 4;

const FILE_EXT = '(?:vue|tsx?|jsx?|mjs|cjs|json|css|scss|md)';

export interface Identifier {
  text: string;
  /** True when it looks like a file name or path (has an extension or a slash). */
  file: boolean;
}

/** Identifiers mentioned in the task text: backticked, CamelCase, useX, <kebab-tag>, file.ext / paths, quoted strings. */
export function extractIdentifiers(text: string): Identifier[] {
  const found = new Map<string, Identifier>();
  const add = (raw: string): void => {
    const t = raw.trim().replace(/^[./\\]+/, '').replace(/[.,;:!?)\]}]+$/, '');
    if (t.length < 2 || t.length > 200) return;
    if (!found.has(t)) found.set(t, { text: t, file: /[/\\]/.test(t) || new RegExp(`\\.${FILE_EXT}$`, 'i').test(t) });
  };
  const addCode = (code: string): void => {
    const raw = code.replace(/\(.*$/s, ''); // a call: keep the callee, drop the arguments
    add(raw);
    // `store.submit()` / `Foo::bar` / `useOrderStore()`: also the dotted parts on their own
    for (const part of raw.split(/[^\p{L}\p{N}_$/\\.-]+/u)) if (part) add(part);
    for (const part of raw.split(/[^\p{L}\p{N}_$]+/u)) if (part.length >= 2) add(part);
  };

  for (const m of text.matchAll(/`([^`\n]+)`/g)) addCode(m[1]!);
  for (const m of text.matchAll(/(["'])((?:(?!\1)[^\n]){2,80})\1/g)) if (!/\s/.test(m[2]!.trim())) add(m[2]!);
  for (const m of text.matchAll(/<\/?([A-Za-z][\w-]*)\b[^>]*>/g)) {
    const tag = m[1]!;
    add(tag);
    if (tag.includes('-')) add(pascal(tag)); // <order-summary> is declared as OrderSummary
  }
  for (const m of text.matchAll(new RegExp(`(?<![\\w/.-])([\\w@$./-]*[\\w-]\\.${FILE_EXT})(?![\\w])`, 'gi'))) add(m[1]!);
  for (const m of text.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)\b/g)) add(m[1]!); // PascalCase
  for (const m of text.matchAll(/\b([a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+)\b/g)) add(m[1]!); // camelCase, useX
  for (const m of text.matchAll(/\b([A-Za-z]+(?:_[A-Za-z0-9]+)+)\b/g)) add(m[1]!); // snake_case
  return [...found.values()];
}

const pascal = (kebab: string): string =>
  kebab.split('-').filter(Boolean).map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');

export interface SymbolIndex {
  /** Nodes matched by identifiers in the text, best first, ties by id. */
  match(text: string, k: number): ScoredId[];
}

export function buildSymbolIndex(graph: Pick<Graph, 'nodes'>): SymbolIndex {
  const byName = new Map<string, GraphNode[]>();
  const byLowerName = new Map<string, GraphNode[]>();
  const byBase = new Map<string, GraphNode[]>(); // file basename with extension → file node
  const byPath = new Map<string, GraphNode[]>();
  const names: { lower: string; node: GraphNode }[] = [];
  const push = (m: Map<string, GraphNode[]>, key: string, node: GraphNode): void => {
    const l = m.get(key);
    if (l) l.push(node);
    else m.set(key, [node]);
  };

  for (const node of graph.nodes) {
    if (node.kind === 'chunk' || node.kind === 'convention') continue;
    if (node.kind === 'file' && node.path) {
      push(byBase, baseName(node.path).toLowerCase(), node);
      push(byPath, node.path.toLowerCase(), node);
    }
    if (!node.name) continue;
    push(byName, node.name, node);
    const lower = node.name.toLowerCase();
    push(byLowerName, lower, node);
    names.push({ lower, node });
  }

  return {
    match(text, k) {
      if (k < 1) return [];
      const best = new Map<string, number>();
      const hit = (node: GraphNode, score: number): void => {
        if ((best.get(node.id) ?? 0) < score) best.set(node.id, score);
      };
      for (const id of extractIdentifiers(text)) {
        if (id.file) {
          const lower = id.text.toLowerCase().replace(/\\/g, '/');
          for (const n of byBase.get(baseName(lower)) ?? []) {
            // a bare basename ("checkout.vue") is exact; a path must also agree with the node's path
            if (!lower.includes('/') || n.path!.toLowerCase().endsWith(lower)) hit(n, SYMBOL_SCORES.exact);
          }
          if (lower.includes('/')) for (const [p, ns] of byPath) if (p.endsWith(lower)) for (const n of ns) hit(n, SYMBOL_SCORES.exact);
          const stem = stripExt(baseName(id.text));
          for (const n of byName.get(stem) ?? []) hit(n, SYMBOL_SCORES.caseInsensitive);
          continue;
        }
        for (const n of byName.get(id.text) ?? []) hit(n, SYMBOL_SCORES.exact);
        const lower = id.text.toLowerCase();
        for (const n of byLowerName.get(lower) ?? []) hit(n, SYMBOL_SCORES.caseInsensitive);
        if (id.text.length >= MIN_PREFIX_LEN) {
          for (const { lower: nl, node } of names) if (nl.length > lower.length && nl.startsWith(lower)) hit(node, SYMBOL_SCORES.prefix);
        }
      }
      return [...best]
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, k);
    },
  };
}

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const stripExt = (f: string): string => f.replace(/\.[A-Za-z0-9]+$/, '');
