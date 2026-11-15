import { describe, expect, it } from 'vitest';
import type { BodyResult } from '../graph/bodies.js';
import { PRESETS, resolveConfig, type VariantConfig } from '../config.js';
import type { Candidate, GraphNode, NodeKind } from '../types.js';
import { countTokens } from '../util/tokens.js';
import { pack, type BodySource, type PackOptions } from './pack.js';

type Strategy = VariantConfig['pack']['strategy'];
const PK = (strategy: Strategy, over: Partial<VariantConfig['pack']> = {}): VariantConfig['pack'] => ({ ...PRESETS.V3.pack, prefix: false, neighbourSignatures: false, sessionDedupe: false, sliceLarge: false, maxBodyTokens: 150, strategy, ...over });

const code = (label: string, lines: number): string => Array.from({ length: lines }, (_, i) => `  const ${label}${i} = compute(${i}, "${label}");`).join('\n');

function node(id: string, kind: NodeKind, path: string, name: string, body: string, start = 1): GraphNode {
  const lines = body.split('\n').length;
  return { id, kind, path, name, range: { startLine: start, endLine: start + lines - 1 }, signature: kind === 'file' ? undefined : `function ${name}() { … }`, tokens: countTokens(body), sigTokens: 6, fileHash: 'h' } as GraphNode;
}
class Bodies implements BodySource {
  constructor(private readonly text: Map<string, string>, private readonly stale = new Set<string>()) {}
  async readMany(nodes: readonly { id: string }[]): Promise<Map<string, BodyResult>> {
    return new Map(nodes.map((n) => [n.id, this.stale.has(n.id) ? ({ ok: false, reason: 'stale' } as const) : this.text.has(n.id) ? ({ ok: true, text: this.text.get(n.id)! } as const) : ({ ok: false, reason: 'missing' } as const)]));
  }
}
const cand = (nodeId: string, score: number, reason = 'seed: bm25 match'): Candidate => ({ nodeId, score, pprScore: score, via: [], reasons: [reason] });

// a.ts: a small and a big function; b.ts: one small function; c.ts: one stale function; d.ts: a big whole file
const A1 = code('a1', 4);
const A2 = code('a2', 60);
const A_FILE = `${A1}\n${A2}`;
const B1 = code('b1', 5);
const B_FILE = B1;
const C1 = code('c1', 4);
const D1 = code('d1', 40);
function world(pk: VariantConfig['pack'], budget = 4000) {
  const nodes = new Map<string, GraphNode>([
    ['file:src/a.ts', node('file:src/a.ts', 'file', 'src/a.ts', 'a.ts', A_FILE)],
    ['fn:a1', node('fn:a1', 'function', 'src/a.ts', 'a1', A1)],
    ['fn:a2', node('fn:a2', 'function', 'src/a.ts', 'a2', A2, 6)],
    ['file:src/b.ts', node('file:src/b.ts', 'file', 'src/b.ts', 'b.ts', B_FILE)],
    ['fn:b1', node('fn:b1', 'function', 'src/b.ts', 'b1', B1)],
    ['file:src/c.ts', node('file:src/c.ts', 'file', 'src/c.ts', 'c.ts', C1)],
    ['fn:c1', node('fn:c1', 'function', 'src/c.ts', 'c1', C1)],
    ['file:src/d.ts', node('file:src/d.ts', 'file', 'src/d.ts', 'd.ts', D1)],
    ['fn:d1', node('fn:d1', 'function', 'src/d.ts', 'd1', D1)],
  ]);
  const text = new Map([['file:src/a.ts', A_FILE], ['fn:a1', A1], ['fn:a2', A2], ['file:src/b.ts', B_FILE], ['fn:b1', B1], ['file:src/c.ts', C1], ['fn:c1', C1], ['file:src/d.ts', D1], ['fn:d1', D1]]);
  const o: PackOptions = { budget, pack: pk, header: { graph: 'g', ms: 1, degraded: [] }, nodes, bodies: new Bodies(text, new Set(['fn:c1'])) };
  return o;
}
const ranked = [cand('fn:a1', 0.9), cand('fn:a2', 0.8), cand('fn:b1', 0.7), cand('fn:c1', 0.6), cand('fn:d1', 0.5)];
const modes = (r: Awaited<ReturnType<typeof pack>>) => r.items.map((i) => `${i.nodeId}:${i.mode}`);

describe('pack.strategy (PROMPTS 137 support)', () => {
  it('body-signature is today\'s behaviour: bodies where they fit, a signature for the rest', async () => {
    const r = await pack(ranked, world(PK('body-signature')));
    expect(modes(r)).toEqual(expect.arrayContaining(['fn:a1:body', 'fn:b1:body', 'fn:a2:signature', 'fn:c1:signature']));
    expect(r.items.some((i) => i.mode === 'signature')).toBe(true);
  });

  it('body-only never emits a signature: too-large, stale and unreadable candidates are skipped', async () => {
    const r = await pack(ranked, world(PK('body-only')));
    expect(r.items.every((i) => i.mode === 'body' || i.mode === 'file')).toBe(true);
    expect(modes(r)).toEqual(expect.arrayContaining(['fn:a1:body', 'fn:b1:body']));
    expect(modes(r)).not.toContain('fn:a2:body'); // 60 lines > maxBodyTokens: skipped, not a signature
    expect(r.items.map((i) => i.nodeId)).not.toContain('fn:c1'); // stale
    expect(r.text).not.toContain('## Related signatures');
  });

  it('body-only also turns off neighbour signatures', async () => {
    const o = world(PK('body-only', { neighbourSignatures: true }));
    const withN = await pack(ranked, { ...o, neighbours: () => [{ nodeId: 'fn:c1', weight: 1 }] });
    expect(withN.items.some((i) => i.mode === 'signature')).toBe(false);
    const sig = await pack(ranked, { ...world(PK('body-signature', { neighbourSignatures: true })), neighbours: () => [{ nodeId: 'fn:d1', weight: 1 }] });
    expect(sig.items.some((i) => i.nodeId === 'fn:d1' && i.mode === 'signature')).toBe(true);
  });

  it('whole-file packs each ranked candidate as its whole file, once per path, in rank order, with the best reasons', async () => {
    const r = await pack(
      [cand('fn:a1', 0.9, 'seed: symbol match'), cand('fn:b1', 0.85), cand('fn:a2', 0.8, 'via calls from a1'), cand('fn:d1', 0.5)],
      world(PK('whole-file')),
    );
    expect(modes(r)).toEqual(['file:src/a.ts:file', 'file:src/b.ts:file', 'file:src/d.ts:file']);
    expect(r.text).toContain('### src/a.ts L1-64 · file a.ts · seed: symbol match');
    expect(r.text.match(/const a10 =/g)).toHaveLength(1);
    expect(r.text).not.toContain('## Related signatures');
    expect(r.tokens).toBeLessThanOrEqual(4000);
  });

  it('whole-file ignores maxBodyTokens (a big file is still a file), and skips a file that cannot fit the budget without emitting anything else', async () => {
    const fits = await pack([cand('fn:d1', 0.9)], world(PK('whole-file', { maxBodyTokens: 50 })));
    expect(modes(fits)).toEqual(['file:src/d.ts:file']);
    const tight = await pack([cand('fn:d1', 0.9), cand('fn:b1', 0.8)], world(PK('whole-file'), 300));
    expect(tight.tokens).toBeLessThanOrEqual(300);
    expect(modes(tight)).toEqual(['file:src/b.ts:file']); // d.ts does not fit 300 tokens; b.ts does
  });

  it('whole-file skips stale files and candidates whose file is unknown', async () => {
    const r = await pack([cand('fn:c1', 0.9), cand('fn:zzz', 0.8), cand('fn:b1', 0.7)], { ...world(PK('whole-file')), bodies: new Bodies(new Map([['file:src/b.ts', B_FILE]]), new Set(['file:src/c.ts'])) });
    expect(modes(r)).toEqual(['file:src/b.ts:file']);
  });

  it('all strategies stay within the budget and are deterministic, whatever the candidate order', async () => {
    for (const s of ['body-signature', 'body-only', 'whole-file'] as const) {
      for (const budget of [400, 900, 4000]) {
        const o = world(PK(s), budget);
        const a = await pack(ranked, o);
        const b = await pack([...ranked].reverse(), world(PK(s), budget));
        expect(countTokens(a.text), `${s} ${budget}`).toBeLessThanOrEqual(budget);
        expect(b.text, `${s} ${budget}`).toBe(a.text);
      }
    }
  });

  it('the three strategies give three different packs', async () => {
    const [bs, bo, wf] = await Promise.all((['body-signature', 'body-only', 'whole-file'] as const).map((s) => pack(ranked, world(PK(s)))));
    expect(new Set([bs!.text, bo!.text, wf!.text]).size).toBe(3);
  });

  it('prefix stays orthogonal: its tokens count against the same budget in every strategy', async () => {
    for (const s of ['body-signature', 'body-only', 'whole-file'] as const) {
      const o = { ...world(PK(s, { prefix: true }), 700), prefix: { conventions: ['- use script setup'], skeleton: ['- src/a.ts: function a1() { … }'] } };
      const r = await pack(ranked, o);
      expect(r.text, s).toContain('## Conventions');
      expect(r.tokens).toBeLessThanOrEqual(700);
    }
  });

  it('configs without the field parse to body-signature; the presets use it', () => {
    const { strategy: _s, ...withoutField } = PRESETS.V3.pack;
    const parsed = resolveConfig({ pack: withoutField }, 'V3');
    expect(parsed.pack.strategy).toBe('body-signature');
    for (const name of ['V1', 'V2', 'V3', 'V3r', 'V4', 'delivery'] as const) expect(PRESETS[name].pack.strategy).toBe('body-signature');
    expect(() => resolveConfig({ pack: { strategy: 'nope' as never } }, 'V3')).toThrow();
  });
});
