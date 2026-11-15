import { describe, expect, it } from 'vitest';
import type { BodyResult } from '../graph/bodies.js';
import { PRESETS, type VariantConfig } from '../config.js';
import type { Candidate, GraphNode } from '../types.js';
import { countTokens } from '../util/tokens.js';
import { pack, type BodySource, type ChunkMeta, type PackOptions } from './pack.js';

const BASE: VariantConfig['pack'] = { ...PRESETS.V3.pack, prefix: false, neighbourSignatures: false, sessionDedupe: false, sliceLarge: true, maxBodyTokens: 200 };

/** ~n tokens of distinct code-ish text. */
const code = (label: string, lines: number): string => Array.from({ length: lines }, (_, i) => `  const ${label}${i} = compute(${i}, "${label}");`).join('\n');

const BIG = code('big', 120); // far over 200 tokens
const nodeOf = (id: string, path: string, name: string, body: string): GraphNode => ({
  id, kind: 'function', path, name, range: { startLine: 1, endLine: 121 }, signature: `function ${name}() { … }`, tokens: countTokens(body), sigTokens: 6, fileHash: 'h',
});
const chunk = (id: string, nodeId: string, path: string, start: number, end: number): ChunkMeta => ({ id, nodeId, path, range: { startLine: start, endLine: end } });

class Bodies implements BodySource {
  seen: string[] = [];
  constructor(private readonly text: Map<string, string>) {}
  async readMany(nodes: readonly { id: string }[]): Promise<Map<string, BodyResult>> {
    return new Map(nodes.map((n) => (this.seen.push(n.id), [n.id, this.text.has(n.id) ? ({ ok: true, text: this.text.get(n.id)! } as const) : ({ ok: false, reason: 'missing' } as const)])));
  }
}
const cand = (nodeId: string, score = 1): Candidate => ({ nodeId, score, pprScore: score, via: [], reasons: ['seed: bm25 match'] });

function setup(over: Partial<PackOptions> = {}, pk: Partial<VariantConfig['pack']> = {}) {
  const node = nodeOf('fn:big', 'src/big.ts', 'big', BIG);
  const small = code('a', 12);
  const part1 = code('p1', 5);
  const part2 = code('p2', 5);
  const part3 = code('p3', 5);
  const text = new Map<string, string>([['fn:big', BIG], ['c1', part1], ['c2', part2], ['c3', part3], ['fn:small', small], ['c-huge', BIG]]);
  const nodes = new Map<string, GraphNode>([[node.id, node], ['fn:small', nodeOf('fn:small', 'src/small.ts', 'small', small)]]);
  const chunks = new Map<string, ChunkMeta>([
    ['c3', chunk('c3', 'fn:big', 'src/big.ts', 61, 70)],
    ['c1', chunk('c1', 'fn:big', 'src/big.ts', 1, 10)],
    ['c2', chunk('c2', 'fn:big', 'src/big.ts', 31, 40)],
  ]);
  const bodies = new Bodies(text);
  const opts: PackOptions = { budget: 4000, pack: { ...BASE, ...pk }, header: { graph: 'g', ms: 1, degraded: [] }, nodes, chunks, bodies, ...over };
  return { opts, bodies };
}

describe('pack.sliceLarge (PROMPTS 134)', () => {
  it('off: an oversized symbol is only a signature (the old behaviour, and the default for V1)', async () => {
    const { opts } = setup({}, { sliceLarge: false });
    const r = await pack([cand('fn:big')], opts);
    expect(r.items).toMatchObject([{ nodeId: 'fn:big', mode: 'signature' }]);
    expect(r.text).not.toContain('(part)');
  });

  it('on: the oversized symbol is shown as its first chunks (source order, at most two), as body items with the chunk range', async () => {
    const { opts } = setup();
    const r = await pack([cand('fn:big')], opts);
    expect(r.items.map((i) => [i.nodeId, i.mode, i.range])).toEqual([
      ['fn:big', 'body', { startLine: 1, endLine: 10 }],
      ['fn:big', 'body', { startLine: 31, endLine: 40 }],
    ]);
    expect(r.text).toContain('### src/big.ts L1-10 · function big (part) · seed: bm25 match');
    expect(r.text).toContain('### src/big.ts L31-40 · function big (part) · seed: bm25 match');
    expect(r.text).toContain('const p10 =');
    expect(r.text).not.toContain('const p30 ='); // the third chunk is not needed
    expect(r.text).not.toContain('const big0 ='); // and the whole body never was
    expect(r.tokens).toBeLessThanOrEqual(4000);
  });

  it('chunk hints (the semantic hits) come first, then source order', async () => {
    const { opts } = setup({ chunkHints: new Map([['fn:big', ['c3']]]) });
    const r = await pack([cand('fn:big')], opts);
    expect(r.items.map((i) => i.range!.startLine)).toEqual([61, 1]);
    expect(r.text.indexOf('const p30 =')).toBeLessThan(r.text.indexOf('const p10 ='));
  });

  it('chunks that are themselves too big are skipped; with no usable chunk it falls back to the signature', async () => {
    const { opts } = setup();
    const huge = new Map(opts.chunks);
    huge.set('c-huge', chunk('c-huge', 'fn:big', 'src/big.ts', 1, 121));
    const onlyHuge = new Map([['c-huge', huge.get('c-huge')!]]);
    const r = await pack([cand('fn:big')], { ...opts, chunks: onlyHuge });
    expect(r.items).toMatchObject([{ nodeId: 'fn:big', mode: 'signature' }]);
    const none = await pack([cand('fn:big')], { ...opts, chunks: new Map() });
    expect(none.items).toMatchObject([{ nodeId: 'fn:big', mode: 'signature' }]);
  });

  it('a symbol that fits whole is packed whole, not sliced', async () => {
    const { opts } = setup();
    const r = await pack([cand('fn:small')], opts);
    expect(r.items).toMatchObject([{ nodeId: 'fn:small', mode: 'body' }]);
    expect(r.text).not.toContain('(part)');
  });

  it('slices are also used when the whole symbol no longer fits the remaining budget', async () => {
    const mid = code('mid', 28);
    const { opts } = setup({}, { maxBodyTokens: 2000 });
    const node = nodeOf('fn:big', 'src/big.ts', 'big', mid);
    const bodies = new Bodies(new Map([['fn:big', mid], ['c1', code('p1', 8)], ['c2', code('p2', 8)]]));
    const tight = await pack([cand('fn:big')], { ...opts, budget: 330, nodes: new Map([['fn:big', node]]), bodies });
    expect(tight.tokens).toBeLessThanOrEqual(330);
    expect(tight.items.some((i) => i.mode === 'body' && i.range?.startLine === 1 && i.range.endLine === 10)).toBe(true);
    expect(tight.text).toContain('(part)');
  });

  it('respects the budget and stays deterministic over many oversized symbols', async () => {
    const { opts } = setup();
    const nodes = new Map(opts.nodes);
    const chunks = new Map(opts.chunks);
    const text = new Map<string, string>();
    const cands: Candidate[] = [];
    for (let i = 0; i < 25; i++) {
      const id = `fn:n${i}`;
      nodes.set(id, nodeOf(id, `src/n${i}.ts`, `n${i}`, BIG));
      for (let k = 0; k < 3; k++) {
        const cid = `c-${i}-${k}`;
        chunks.set(cid, chunk(cid, id, `src/n${i}.ts`, 1 + k * 30, 10 + k * 30));
        text.set(cid, code(`x${i}${k}`, 10));
      }
      cands.push(cand(id, 1 - i / 100));
    }
    const o = { ...opts, nodes, chunks, bodies: new Bodies(text), budget: 1500 };
    const a = await pack(cands, o);
    const b = await pack([...cands].reverse(), { ...o, bodies: new Bodies(text) });
    expect(a.tokens).toBeLessThanOrEqual(1500);
    expect(countTokens(a.text)).toBeLessThanOrEqual(1500);
    expect(b.text).toBe(a.text);
    expect(a.items.filter((i) => i.mode === 'body').length).toBeGreaterThan(3);
  });

  it('every V2/V3 preset slices; V1 (chunk units) does not change', () => {
    for (const name of ['V2', 'V3', 'V3r', 'V4', 'delivery'] as const) {
      expect(PRESETS[name].pack, name).toMatchObject({ sliceLarge: true, maxBodyTokens: 600 });
    }
    expect(PRESETS.V1.pack).toMatchObject({ sliceLarge: false, maxBodyTokens: 1_200 });
  });
});
