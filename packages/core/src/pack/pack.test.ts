import { describe, expect, it } from 'vitest';
import type { BodyResult } from '../graph/bodies.js';
import { PRESETS, type VariantConfig } from '../config.js';
import type { Candidate, GraphNode, NodeKind } from '../types.js';
import { countTokens } from '../util/tokens.js';
import { pack, type BodySource, type PackOptions } from './pack.js';

const PACK: VariantConfig['pack'] = { ...PRESETS.V3.pack, prefix: false, neighbourSignatures: false, sessionDedupe: false };

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A node plus the body text it would have on disk. */
function mk(id: string, kind: NodeKind, path: string, name: string, startLine: number, body: string, signature = `function ${name}() { … }`): { node: GraphNode; body: string } {
  const lines = body.split('\n').length;
  return { node: { id, kind, path, name, range: { startLine, endLine: startLine + lines - 1 }, signature, tokens: countTokens(body), sigTokens: countTokens(signature), fileHash: 'h' }, body };
}

class FakeBodies implements BodySource {
  reads = 0;
  constructor(private readonly bodies: Map<string, string>, private readonly stale = new Set<string>()) {}
  async readMany(nodes: readonly { id: string }[]): Promise<Map<string, BodyResult>> {
    this.reads++;
    return new Map(nodes.map((n) => [n.id, this.stale.has(n.id) ? ({ ok: false, reason: 'stale' } as const) : this.bodies.has(n.id) ? ({ ok: true, text: this.bodies.get(n.id)! } as const) : ({ ok: false, reason: 'missing' } as const)]));
  }
}

const cand = (nodeId: string, score: number, reason = 'seed: symbol match'): Candidate => ({ nodeId, score, pprScore: score, via: [], reasons: [reason] });

function setup(items: ReturnType<typeof mk>[], extra: Partial<PackOptions> = {}, stale?: Set<string>) {
  const nodes = new Map(items.map((i) => [i.node.id, i.node]));
  const bodies = new FakeBodies(new Map(items.map((i) => [i.node.id, i.body])), stale);
  const opts: PackOptions = { budget: 4000, pack: PACK, header: { graph: 'a1b2c3d4e5', ms: 212, degraded: [] }, nodes, bodies, ...extra };
  return opts;
}

const BTN = mk('comp:btn', 'component', 'src/components/CheckoutButton.vue', 'CheckoutButton', 1, '<script setup lang="ts">\nconst x = 1;\n</script>');
const STORE = mk('store:order', 'store', 'src/stores/order.ts', 'useOrderStore', 1, 'export const useOrderStore = defineStore("order", () => {\n  return {};\n});', 'export const useOrderStore = defineStore(\'order\', () => { … })');

describe('pack output format (PROMPTS 092, SPEC §9.5)', () => {
  it('renders header, intro, code section with heading, fenced body and footer', async () => {
    const r = await pack([cand('comp:btn', 1)], setup([BTN]));
    expect(r.text.startsWith('<click_context version="1" tokens="')).toBe(true);
    expect(r.text).toContain('budget="4000" items="1" graph="a1b2c3d" ms="212" degraded="">');
    expect(r.text).toContain('Context selected by Click for this task.');
    expect(r.text).toContain('## Code\n### src/components/CheckoutButton.vue L1-3 · component CheckoutButton · seed: symbol match\n```vue\n<script setup lang="ts">');
    expect(r.text.endsWith('\n```\n</click_context>')).toBe(true);
    expect(r.items).toMatchObject([{ nodeId: 'comp:btn', mode: 'body', path: 'src/components/CheckoutButton.vue' }]);
  });

  it('tokens attribute is the real count and the text fits the budget', async () => {
    const r = await pack([cand('comp:btn', 1), cand('store:order', 0.5)], setup([BTN, STORE]));
    const attr = Number(/tokens="(\d+)"/.exec(r.text)![1]);
    expect(Math.abs(attr - countTokens(r.text))).toBeLessThanOrEqual(1);
    expect(Math.abs(r.tokens - countTokens(r.text))).toBeLessThanOrEqual(1); // counted once, additively; exact near the limit
    expect(r.tokens).toBeLessThanOrEqual(4000);
  });

  it('empty sections are omitted; no candidates gives just the frame', async () => {
    const r = await pack([], setup([BTN]));
    expect(r.text).not.toContain('##');
    expect(r.text).toContain('items="0"');
    expect(r.items).toEqual([]);
  });

  it('degraded flags go into the header', async () => {
    const r = await pack([cand('comp:btn', 1)], setup([BTN], { header: { graph: 'g', ms: 5, degraded: ['semantic-timeout', 'graph-replica'] } }));
    expect(r.text).toContain('degraded="semantic-timeout,graph-replica"');
  });

  it('a body that contains a code fence gets a longer fence', async () => {
    const md = mk('doc', 'function', 'README.md', 'doc', 1, 'text\n```ts\nconst a = 1\n```\nend');
    const r = await pack([cand('doc', 1)], setup([md]));
    expect(r.text).toContain('````md\ntext\n```ts');
  });
});

describe('selection (PROMPTS 092, SPEC §9.2)', () => {
  it('orders by score then node id; ties are stable', async () => {
    const a = mk('a', 'function', 'src/a.ts', 'a', 1, 'const a = 1;');
    const b = mk('b', 'function', 'src/b.ts', 'b', 1, 'const b = 1;');
    const c = mk('c', 'function', 'src/c.ts', 'c', 1, 'const c = 1;');
    const r = await pack([cand('c', 0.5), cand('b', 0.5), cand('a', 0.9)], setup([a, b, c]));
    expect(r.items.map((i) => i.nodeId)).toEqual(['a', 'b', 'c']);
  });

  it('a body over maxBodyTokens becomes a signature; one that does not fit the budget too', async () => {
    const big = mk('big', 'function', 'src/big.ts', 'big', 1, Array.from({ length: 400 }, (_, i) => `const v${i} = ${i};`).join('\n'), 'function big(): void { … }');
    const r = await pack([cand('big', 1)], setup([big], { pack: { ...PACK, maxBodyTokens: 100 } }));
    expect(r.items).toMatchObject([{ nodeId: 'big', mode: 'signature' }]);
    expect(r.text).toContain('## Related signatures\n- src/big.ts L1: function big(): void { … }');
    expect(r.text).not.toContain('const v1 =');

    const tight = await pack([cand('big', 1)], setup([big], { budget: 500, pack: { ...PACK, maxBodyTokens: 5000 } }));
    expect(tight.items[0]!.mode).toBe('signature');
    expect(tight.tokens).toBeLessThanOrEqual(500);
  });

  it('a stale body falls back to the signature and flags stale-body', async () => {
    const r = await pack([cand('comp:btn', 1)], setup([BTN], {}, new Set(['comp:btn'])));
    expect(r.items).toMatchObject([{ nodeId: 'comp:btn', mode: 'signature' }]);
    expect(r.degraded).toContain('stale-body');
    expect(r.text).not.toContain('<script setup');
  });

  it('session dedupe: a node already sent becomes a ref line', async () => {
    const r = await pack([cand('comp:btn', 1), cand('store:order', 0.5)], setup([BTN, STORE], { pack: { ...PACK, sessionDedupe: true }, sent: new Set(['store:order']) }));
    expect(r.items.map((i) => [i.nodeId, i.mode])).toEqual([['comp:btn', 'body'], ['store:order', 'ref']]);
    expect(r.text).toContain('## Already sent this session\n- src/stores/order.ts#useOrderStore');
    expect(r.text).not.toContain('defineStore("order"');
    const off = await pack([cand('store:order', 1)], setup([STORE], { sent: new Set(['store:order']) }));
    expect(off.items[0]!.mode).toBe('body'); // dedupe off: sent set ignored
  });

  it('small-file merge: two bodies from one small file become one whole-file item', async () => {
    const f = mk('file:src/s.ts', 'file', 'src/s.ts', 's.ts', 1, 'export function f1() {\n  return 1;\n}\nexport function f2() {\n  return 2;\n}');
    const s1 = mk('f1', 'function', 'src/s.ts', 'f1', 1, 'export function f1() {\n  return 1;\n}');
    const s2 = mk('f2', 'function', 'src/s.ts', 'f2', 4, 'export function f2() {\n  return 2;\n}');
    const r = await pack([cand('f1', 0.9), cand('f2', 0.8)], setup([f, s1, s2]));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ nodeId: 'file:src/s.ts', mode: 'file' });
    expect(r.text).toContain('### src/s.ts L1-6 · file s.ts · seed: symbol match');
    expect(r.text.match(/export function f1/g)).toHaveLength(1);

    const big = await pack([cand('f1', 0.9), cand('f2', 0.8)], setup([f, s1, s2], { pack: { ...PACK, smallFileTokens: 3 } }));
    expect(big.items.map((i) => i.mode)).toEqual(['body', 'body']); // file too large: no merge
    const lone = await pack([cand('f1', 0.9)], setup([f, s1, s2]));
    expect(lone.items[0]!.mode).toBe('body'); // only one body from the file
  });

  it('neighbour signatures: strongest neighbours first, none already included, capped, only with a signature', async () => {
    const hub = mk('hub', 'function', 'src/hub.ts', 'hub', 1, 'const hub = 1;');
    const n1 = mk('n1', 'function', 'src/n1.ts', 'n1', 1, 'x', 'function n1(): string { … }');
    const n2 = mk('n2', 'function', 'src/n2.ts', 'n2', 1, 'x', 'function n2(): number { … }');
    const n3 = mk('n3', 'function', 'src/n3.ts', 'n3', 1, 'x');
    const n4 = mk('n4', 'function', 'src/n4.ts', 'n4', 1, 'x');
    const n5 = mk('n5', 'function', 'src/n5.ts', 'n5', 1, 'x');
    const fileNb = mk('file:x', 'file', 'src/x.ts', 'x.ts', 1, 'x');
    const items = [hub, n1, n2, n3, n4, n5, fileNb];
    const neighbours = (id: string) => (id === 'hub' ? [{ nodeId: 'n2', weight: 1 }, { nodeId: 'file:x', weight: 5 }, { nodeId: 'n1', weight: 3 }, { nodeId: 'hub', weight: 9 }, { nodeId: 'n3', weight: 0.5 }, { nodeId: 'n4', weight: 0.4 }, { nodeId: 'n5', weight: 0.1 }] : []);
    const r = await pack([cand('hub', 1)], setup(items, { pack: { ...PACK, neighbourSignatures: true }, neighbours }));
    expect(r.items.map((i) => i.nodeId)).toEqual(['hub', 'n1', 'n2', 'n3']);
    expect(r.text).toContain('## Related signatures\n- src/n1.ts L1: function n1(): string { … }\n- src/n2.ts L1: function n2(): number { … }');
    const off = await pack([cand('hub', 1)], setup(items, { neighbours }));
    expect(off.items.map((i) => i.nodeId)).toEqual(['hub']);
  });

  it('chunk units (V1): candidates that are chunk ids pack the chunk range of their parent', async () => {
    const parent = mk('sym:src/a.ts#a', 'function', 'src/a.ts', 'a', 1, 'function a() {}\nconst more = 1;');
    const nodes = new Map([[parent.node.id, parent.node]]);
    const chunks = new Map([['chunk:src/a.ts#a#0', { id: 'chunk:src/a.ts#a#0', nodeId: parent.node.id, path: 'src/a.ts', range: { startLine: 1, endLine: 1 } }]]);
    const seen: string[] = [];
    const bodies: BodySource = { readMany: async (ns) => new Map(ns.map((n) => (seen.push(n.id), [n.id, { ok: true, text: 'function a() {}' } as const]))) };
    const r = await pack([cand('chunk:src/a.ts#a#0', 1)], { budget: 4000, pack: PACK, header: { graph: 'g', ms: 1, degraded: [] }, nodes, chunks, bodies });
    expect(seen).toEqual(['chunk:src/a.ts#a#0']);
    expect(r.items).toMatchObject([{ nodeId: 'chunk:src/a.ts#a#0', mode: 'body', range: { startLine: 1, endLine: 1 } }]);
    expect(r.text).toContain('### src/a.ts L1-1 · chunk of a · seed: symbol match');
  });
});

describe('prefix (PROMPTS 092, SPEC §9.1)', () => {
  const conventions = Array.from({ length: 30 }, (_, i) => `- convention number ${i} says to do a particular thing in components`);
  const skeleton = Array.from({ length: 30 }, (_, i) => `- src/stores/s${i}.ts: export const useS${i}Store = defineStore('s${i}', () => { … })`);

  it('conventions ≤ 8% and skeleton ≤ 12% of the budget; unused budget flows to task items', async () => {
    const r = await pack([cand('comp:btn', 1)], setup([BTN], { budget: 2000, pack: { ...PACK, prefix: true }, prefix: { conventions, skeleton } }));
    const section = (title: string) => r.text.split(`## ${title}\n`)[1]!.split('\n\n')[0]!;
    expect(countTokens(section('Conventions'))).toBeLessThanOrEqual(2000 * 0.08 + 2);
    expect(countTokens(section('Skeleton'))).toBeLessThanOrEqual(2000 * 0.12 + 2);
    expect(r.items.map((i) => i.nodeId)).toEqual(['comp:btn']); // prefix lines are not items
    expect(r.text.indexOf('## Conventions')).toBeLessThan(r.text.indexOf('## Skeleton'));
    expect(r.text.indexOf('## Skeleton')).toBeLessThan(r.text.indexOf('## Code'));
  });

  it('prefix off or absent adds nothing', async () => {
    expect((await pack([cand('comp:btn', 1)], setup([BTN], { pack: { ...PACK, prefix: false }, prefix: { conventions, skeleton } }))).text).not.toContain('## Conventions');
    expect((await pack([cand('comp:btn', 1)], setup([BTN], { pack: { ...PACK, prefix: true } }))).text).not.toContain('## Skeleton');
  });
});

describe('budget guarantee (PROMPTS 092, property)', () => {
  function world(seed: number) {
    const rnd = mulberry32(seed);
    const words = ['order', 'store', 'cart', 'item', 'total', 'submit', 'async', 'await', 'return', 'const', 'ref', 'computed', 'props', 'emit', 'user', 'id'];
    const items: ReturnType<typeof mk>[] = [];
    const n = 5 + Math.floor(rnd() * 40);
    for (let i = 0; i < n; i++) {
      const lines = 1 + Math.floor(rnd() * 60);
      const body = Array.from({ length: lines }, () => `  ${Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => words[Math.floor(rnd() * words.length)]).join(' ')};`).join('\n');
      const path = `src/f${Math.floor(rnd() * 10)}.${['ts', 'vue', 'tsx'][Math.floor(rnd() * 3)]}`;
      items.push(mk(`n${i}`, (['function', 'component', 'store'] as const)[Math.floor(rnd() * 3)]!, path, `name${i}`, 1 + Math.floor(rnd() * 200), body));
    }
    for (let f = 0; f < 10; f++) for (const ext of ['ts', 'vue', 'tsx']) items.push(mk(`file:src/f${f}.${ext}`, 'file', `src/f${f}.${ext}`, `f${f}.${ext}`, 1, 'x\n'.repeat(5)));
    const cands = items.filter((i) => i.node.kind !== 'file').map((i) => cand(i.node.id, rnd()));
    return { rnd, items, cands };
  }

  it('tokens ≤ budget, always; identical input gives identical text (200 random worlds)', async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { rnd, items, cands } = world(seed);
      const budget = 500 + Math.floor(rnd() * 7500);
      const pk = { ...PACK, prefix: rnd() < 0.5, neighbourSignatures: rnd() < 0.5, sessionDedupe: rnd() < 0.5, maxBodyTokens: 100 + Math.floor(rnd() * 1500), smallFileTokens: Math.floor(rnd() * 800) + 1 };
      const sent = new Set(cands.filter(() => rnd() < 0.2).map((c) => c.nodeId));
      const neighbours = (id: string) => cands.slice(0, 6).map((c, i) => ({ nodeId: c.nodeId, weight: (id.length + i) % 5 }));
      const opts = setup(items, { budget, pack: pk, sent, neighbours, prefix: { conventions: ['- use script setup', '- use pinia setup stores'], skeleton: ['- src/stores/order.ts: export const useOrderStore'] } });
      const a = await pack(cands, opts);
      const b = await pack([...cands].reverse(), opts);
      expect(countTokens(a.text), `seed ${seed} budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(Math.abs(a.tokens - countTokens(a.text))).toBeLessThanOrEqual(1);
      expect(b.text, `seed ${seed}`).toBe(a.text);
      if (a.text) expect(a.text.endsWith('</click_context>')).toBe(true);
    }
  });

  it('a budget smaller than the frame gives an empty result instead of overshooting', async () => {
    const r = await pack([cand('comp:btn', 1)], setup([BTN], { budget: 20 }));
    expect(r).toMatchObject({ text: '', tokens: 0, items: [] });
  });

  it('blocks are dropped from the end when the estimate was optimistic', async () => {
    // index-time token counts understated: the real text is bigger than the estimate, so the guarantee must trim it
    const liar = mk('liar', 'function', 'src/liar.ts', 'liar', 1, Array.from({ length: 300 }, (_, i) => `const w${i} = "${'x'.repeat(i % 7)}";`).join('\n'));
    liar.node.tokens = 10;
    const small = mk('small', 'function', 'src/s.ts', 'small', 1, 'const s = 1;');
    const r = await pack([cand('liar', 1), cand('small', 0.5)], setup([liar, small], { budget: 600 }));
    expect(r.tokens).toBeLessThanOrEqual(600);
    expect(countTokens(r.text)).toBeLessThanOrEqual(600);
  });
});
