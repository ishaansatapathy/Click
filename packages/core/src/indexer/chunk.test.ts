import { describe, expect, it } from 'vitest';
import { countTokens } from '../util/tokens.js';
import { MAX_CHUNK_TOKENS, MERGE_CAP_TOKENS, MIN_CHUNK_TOKENS, chunkFile, softBoundaries, splitRange, statementBoundaries, topLevelBoundaries } from './chunk.js';
import { parseTs } from './ts-parse.js';
import { extractTsSymbols } from './ts-symbols.js';

const PATH = 'src/x.ts';
const FALLBACK = 'file:src/x.ts';

/** A statement worth about `tokens` tokens. */
const stmt = (i: number, tokens = 60): string => `  const v${i} = [${Array.from({ length: Math.ceil(tokens / 3) }, (_, k) => `'w${i}_${k}'`).join(', ')}];`;

function chunksFor(content: string) {
  const sf = parseTs(content, PATH);
  const syms = extractTsSymbols(sf).filter((s) => s.kind !== 'method');
  const units = syms.map((s) => ({
    nodeId: `sym:${PATH}#${s.name}`,
    name: s.name,
    range: s.range,
    boundaries: statementBoundaries(sf, s.range),
  }));
  return chunkFile({ path: PATH, content, fallbackNodeId: FALLBACK, units });
}

describe('chunkFile (SPEC §5.5)', () => {
  it('one chunk per top-level symbol, with exact text and ranges', () => {
    const big = (name: string) => `export function ${name}() {\n${[0, 1].map((i) => stmt(i, 40)).join('\n')}\n}`;
    const content = `${big('alpha')}\n\n${big('beta')}\n`;
    const cs = chunksFor(content);
    expect(cs.map((c) => [c.id, c.nodeId, c.range])).toEqual([
      ['chunk:src/x.ts#alpha#0', 'sym:src/x.ts#alpha', { startLine: 1, endLine: 4 }],
      ['chunk:src/x.ts#beta#0', 'sym:src/x.ts#beta', { startLine: 6, endLine: 9 }],
    ]);
    expect(cs[0]!.text).toBe(content.split('\n').slice(0, 4).join('\n'));
  });

  it('splits an oversized function at statement boundaries only, every part within the limit', () => {
    const body = Array.from({ length: 30 }, (_, i) => stmt(i, 45)).join('\n');
    const content = `export function huge() {\n${body}\n}\n`;
    const cs = chunksFor(content);
    expect(cs.length).toBeGreaterThan(2);
    for (const c of cs) expect(countTokens(c.text)).toBeLessThanOrEqual(MAX_CHUNK_TOKENS + 60); // a statement may overshoot by itself
    expect(cs.map((c) => c.id)).toEqual(cs.map((_, i) => `chunk:src/x.ts#huge#${i}`));
    // contiguous and complete: parts tile the function exactly
    expect(cs[0]!.range.startLine).toBe(1);
    for (let i = 1; i < cs.length; i++) expect(cs[i]!.range.startLine).toBe(cs[i - 1]!.range.endLine + 1);
    expect(cs.at(-1)!.range.endLine).toBe(content.trimEnd().split('\n').length);
    // every split point starts a statement
    for (const c of cs.slice(1)) expect(c.text.split('\n')[0]).toMatch(/^ {2}const v\d+ = /);
  });

  it('merges runs of adjacent tiny chunks into `_file` chunks owned by the fallback node; a merged chunk that reaches the minimum stops absorbing', () => {
    const content = Array.from({ length: 4 }, (_, i) => `export const c${i} = () => ${i};`).join('\n') + '\n';
    const cs = chunksFor(content);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ id: 'chunk:src/x.ts#_file#0', nodeId: FALLBACK, range: { startLine: 1, endLine: 4 } });

    const many = Array.from({ length: 80 }, (_, i) => `export const c${i} = () => ${i};`).join('\n') + '\n';
    const cs2 = chunksFor(many);
    expect(cs2.length).toBeGreaterThan(1);
    for (const c of cs2) expect(countTokens(c.text)).toBeLessThanOrEqual(MERGE_CAP_TOKENS + MIN_CHUNK_TOKENS);
  });

  it('keeps a lone tiny symbol as its own chunk, and does not merge it with a big neighbour', () => {
    const big = `export function big() {\n${Array.from({ length: 4 }, (_, i) => stmt(i, 45)).join('\n')}\n}`;
    const cs = chunksFor(`${big}\nexport const tiny = () => 1;\n`);
    expect(cs.map((c) => c.id)).toEqual(['chunk:src/x.ts#big#0', 'chunk:src/x.ts#tiny#0']);
  });

  it('a file without symbols is one `_file` chunk; an empty file has none', () => {
    const cs = chunkFile({ path: PATH, content: "import { a } from './a'\napp.use(a)\n", fallbackNodeId: FALLBACK, units: [] });
    expect(cs).toEqual([{ id: 'chunk:src/x.ts#_file#0', nodeId: FALLBACK, path: PATH, range: { startLine: 1, endLine: 2 }, text: "import { a } from './a'\napp.use(a)" }]);
    expect(chunkFile({ path: PATH, content: '\n\n', fallbackNodeId: FALLBACK, units: [] })).toEqual([]);
  });

  it('template chunk: own label, split by supplied element boundaries when large', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `  <p>${'word '.repeat(12)}${i}</p>`);
    const content = `<template>\n${rows.join('\n')}\n</template>\n`;
    const boundaries = Array.from({ length: 40 }, (_, i) => i + 2);
    const cs = chunkFile({
      path: 'src/V.vue', content, fallbackNodeId: 'sym:src/V.vue#V',
      units: [], template: { nodeId: 'sym:src/V.vue#V', name: '_template', range: { startLine: 1, endLine: 42 }, boundaries },
    });
    expect(cs.length).toBeGreaterThan(1);
    expect(cs.every((c) => c.id.startsWith('chunk:src/V.vue#_template#'))).toBe(true);
    expect(cs.map((c) => c.range.startLine)[0]).toBe(1);
  });

  it('ids stay stable: editing one symbol leaves the other symbols\' chunk ids unchanged', () => {
    const mk = (edit: string) => `export function a() {\n${stmt(0, 90)}\n}\n\nexport function b() {\n${stmt(1, 90)}\n${edit}\n}\n\nexport function c() {\n${stmt(2, 90)}\n}\n`;
    const before = chunksFor(mk(''));
    const after = chunksFor(mk(stmt(9, 120)));
    const idOf = (cs: typeof before, name: string) => cs.filter((c) => c.nodeId.endsWith(`#${name}`)).map((c) => c.id);
    expect(idOf(after, 'a')).toEqual(idOf(before, 'a'));
    expect(idOf(after, 'c')).toEqual(idOf(before, 'c'));
  });
});

describe('splitRange / boundaries', () => {
  it('splitRange keeps a single oversized, boundary-less part whole', () => {
    const tok = (a: number, b: number) => (b - a + 1) * 100;
    expect(splitRange({ startLine: 1, endLine: 10 }, [], tok)).toEqual([[1, 10]]);
    expect(splitRange({ startLine: 1, endLine: 10 }, [5], tok)).toEqual([[1, 4], [5, 10]]);
  });

  it('softBoundaries: first non-blank line after a blank line', () => {
    expect(softBoundaries(['a', 'b', '', 'c', 'd', '', '', 'e'], { startLine: 1, endLine: 8 })).toEqual([4, 8]);
  });

  it('statementBoundaries: function bodies, class members, store setup callbacks, object properties', () => {
    const sf = parseTs(`export function f() {
  a();
  b();
}
export class C {
  /** doc */
  m() {}
  n() {}
}
export const useS = defineStore('s', () => {
  const x = 1;
  return { x };
});
export const o = { p: 1, q: 2 };`);
    const syms = extractTsSymbols(sf).filter((s) => s.kind !== 'method');
    const bounds = Object.fromEntries(syms.map((s) => [s.name, statementBoundaries(sf, s.range)]));
    expect(bounds).toEqual({ f: [2, 3], C: [6, 8], useS: [11, 12], o: [14] }); // o's properties share its first line
    expect(topLevelBoundaries(sf, 10)).toEqual([11, 15, 20, 24]);
  });
});
