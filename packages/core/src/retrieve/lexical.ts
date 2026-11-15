// PROMPTS 085: BM25 over graph nodes, built from the graph itself (no chunk text, no network).
//   fields: name ×3, path ×1.5, signature ×1, doc ×0.5 (term frequency is the weighted sum across fields: BM25F-lite).
//   k1 = 1.2, b = 0.75. Chunk nodes are skipped (their parent symbol is what we want to seed).
//   tokenizer: split camelCase / PascalCase / kebab / snake / digit boundaries, lowercase, drop 1-char tokens, strip a
//   trailing plural "s" from tokens longer than 3, so `useOrderStore` → `use order store` and "orders" matches `order`.

import type { Graph, GraphNode } from '../types.js';
import type { ScoredId } from '../store/types.js';

const K1 = 1.2;
const B = 0.75;
const FIELD_WEIGHTS = { name: 3, path: 1.5, signature: 1, doc: 0.5 } as const;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  // words = runs of letters / digits; then split inside a run on case and digit boundaries
  for (const run of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const parts = run
      .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2') // fooBar → foo Bar
      .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2') // HTMLParser → HTML Parser
      .replace(/(\p{L})(\p{N})/gu, '$1 $2') // v2 → v 2
      .replace(/(\p{N})(\p{L})/gu, '$1 $2')
      .split(' ');
    for (const part of parts) {
      let t = part.toLowerCase();
      if (t.length < 2) continue;
      if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
      out.push(t);
    }
  }
  return out;
}

export interface LexicalIndex {
  readonly docCount: number;
  /** Top k nodes for the query, best first; ties broken by node id. Empty for an empty or unknown query. */
  search(query: string, k: number): ScoredId[];
}

interface Posting {
  doc: number; // index into ids
  tf: number; // field-weighted term frequency
}

export function buildLexicalIndex(graph: Pick<Graph, 'nodes'>): LexicalIndex {
  const ids: string[] = [];
  const lengths: number[] = [];
  const postings = new Map<string, Posting[]>();

  for (const node of graph.nodes) {
    if (node.kind === 'chunk') continue;
    const tf = fieldTerms(node);
    let len = 0;
    for (const v of tf.values()) len += v;
    if (len === 0) continue;
    const doc = ids.length;
    ids.push(node.id);
    lengths.push(len);
    for (const [term, f] of tf) {
      let list = postings.get(term);
      if (!list) postings.set(term, (list = []));
      list.push({ doc, tf: f });
    }
  }

  const n = ids.length;
  const avgLen = n === 0 ? 1 : lengths.reduce((a, b) => a + b, 0) / n;

  return {
    docCount: n,
    search(query: string, k: number): ScoredId[] {
      if (n === 0 || k < 1) return [];
      const scores = new Map<number, number>();
      for (const term of new Set(tokenize(query))) {
        const list = postings.get(term);
        if (!list) continue;
        const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
        for (const { doc, tf } of list) {
          const norm = tf + K1 * (1 - B + (B * lengths[doc]!) / avgLen);
          scores.set(doc, (scores.get(doc) ?? 0) + (idf * tf * (K1 + 1)) / norm);
        }
      }
      return [...scores]
        .map(([doc, score]) => ({ id: ids[doc]!, score }))
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, k);
    },
  };
}

function fieldTerms(node: GraphNode): Map<string, number> {
  const tf = new Map<string, number>();
  const add = (text: string | undefined | null, weight: number): void => {
    if (!text) return;
    for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + weight);
  };
  add(node.name, FIELD_WEIGHTS.name);
  add(node.path, FIELD_WEIGHTS.path);
  add(node.signature, FIELD_WEIGHTS.signature);
  add(node.doc, FIELD_WEIGHTS.doc);
  return tf;
}
