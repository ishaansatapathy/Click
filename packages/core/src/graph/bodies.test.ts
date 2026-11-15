import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSourceFile } from '../indexer/discover.js';
import type { GraphNode } from '../types.js';
import { BodyReader } from './bodies.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'click-bodies-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (rel: string, text: string, mtime?: number) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
  if (mtime !== undefined) utimesSync(join(root, rel), mtime, mtime);
};
/** A node the way the indexer would make it: range + the hash discovery computed for that file. */
async function node(rel: string, startLine: number, endLine: number): Promise<Pick<GraphNode, 'id' | 'path' | 'range' | 'fileHash'>> {
  const f = await readSourceFile(root, rel);
  if ('reason' in f) throw new Error(f.reason);
  return { id: `sym:${rel}#x${startLine}`, path: rel, range: { startLine, endLine }, fileHash: f.hash };
}

const SRC = ['line 1', 'export function a() {', '  return 1;', '}', '', 'export const b = 2;'].join('\n') + '\n';

describe('BodyReader (PROMPTS 084)', () => {
  it('returns exactly the node\'s lines from the working tree', async () => {
    put('src/a.ts', SRC);
    const r = new BodyReader(root);
    expect(await r.read(await node('src/a.ts', 2, 4))).toEqual({ ok: true, text: 'export function a() {\n  return 1;\n}' });
    expect(await r.read(await node('src/a.ts', 6, 6))).toEqual({ ok: true, text: 'export const b = 2;' });
  });

  it('CRLF files and a BOM give the same text and match the hash discovery computed (Windows)', async () => {
    put('src/crlf.ts', '﻿' + SRC.replace(/\n/g, '\r\n'));
    const r = new BodyReader(root);
    const res = await r.read(await node('src/crlf.ts', 2, 4));
    expect(res).toEqual({ ok: true, text: 'export function a() {\n  return 1;\n}' });
    expect((res as { text: string }).text).not.toContain('\r');
  });

  it('a file edited after indexing is stale: no body, and the owner is told once per path', async () => {
    put('src/a.ts', SRC, 1_000);
    const stale: string[] = [];
    const r = new BodyReader(root, { onStale: (p) => stale.push(p) });
    const n = await node('src/a.ts', 2, 4);
    expect((await r.read(n)).ok).toBe(true);

    put('src/a.ts', SRC.replace('return 1', 'return 2'), 2_000);
    expect(await r.read(n)).toEqual({ ok: false, reason: 'stale' });
    expect(await r.read(n)).toEqual({ ok: false, reason: 'stale' });
    expect(await r.read(await node('src/a.ts', 6, 6).then((m) => ({ ...m, fileHash: n.fileHash })))).toEqual({ ok: false, reason: 'stale' });
    expect(stale).toEqual(['src/a.ts']); // reported once, not once per read
    expect(r.stats.stale).toBe(3);
  });

  it('once the node carries the new hash (after a re-index) reads work again and staleness can be reported again', async () => {
    put('src/a.ts', SRC, 1_000);
    const stale: string[] = [];
    const r = new BodyReader(root, { onStale: (p) => stale.push(p) });
    const old = await node('src/a.ts', 2, 4);
    put('src/a.ts', SRC.replace('return 1', 'return 2'), 2_000);
    expect((await r.read(old)).ok).toBe(false);
    const fresh = await node('src/a.ts', 2, 4);
    expect(await r.read(fresh)).toEqual({ ok: true, text: 'export function a() {\n  return 2;\n}' });
    put('src/a.ts', SRC.replace('return 1', 'return 3'), 3_000);
    expect((await r.read(fresh)).ok).toBe(false);
    expect(stale).toEqual(['src/a.ts', 'src/a.ts']);
  });

  it('missing files, unreadable paths and nodes without a path or range', async () => {
    mkdirSync(join(root, 'src/dir.ts'), { recursive: true });
    const r = new BodyReader(root);
    const base = { fileHash: 'x', range: { startLine: 1, endLine: 2 } };
    expect(await r.read({ ...base, path: 'src/nope.ts' })).toEqual({ ok: false, reason: 'missing' });
    expect(await r.read({ ...base, path: 'src/dir.ts' })).toEqual({ ok: false, reason: 'unreadable' });
    expect(await r.read({ ...base, path: null })).toEqual({ ok: false, reason: 'missing' });
    expect(await r.read({ fileHash: 'x', path: 'src/a.ts' })).toEqual({ ok: false, reason: 'missing' });
  });

  it('caches by stat: repeated reads load the file once; a changed mtime or size reloads it', async () => {
    put('src/a.ts', SRC, 1_000);
    const r = new BodyReader(root);
    const n = await node('src/a.ts', 2, 4);
    for (let i = 0; i < 5; i++) await r.read(n);
    expect(r.stats).toMatchObject({ loads: 1, hits: 4 });
    put('src/a.ts', SRC, 5_000); // same content, new mtime: reload, still valid
    expect((await r.read(n)).ok).toBe(true);
    expect(r.stats.loads).toBe(2);
  });

  it('readMany loads each file once and answers per node id', async () => {
    put('src/a.ts', SRC);
    put('src/b.ts', 'one\ntwo\nthree\n');
    const r = new BodyReader(root);
    const nodes = [await node('src/a.ts', 2, 2), await node('src/a.ts', 3, 3), await node('src/a.ts', 6, 6), await node('src/b.ts', 2, 3)];
    const out = await r.readMany(nodes);
    expect([...out.values()].map((v) => (v.ok ? v.text : v.reason))).toEqual(['export function a() {', '  return 1;', 'export const b = 2;', 'two\nthree']);
    expect(r.stats.loads).toBe(2);
  });

  it('concurrent reads of one cold file share a single load', async () => {
    put('src/a.ts', SRC);
    const r = new BodyReader(root);
    const n = await node('src/a.ts', 1, 1);
    const results = await Promise.all(Array.from({ length: 20 }, () => r.read(n)));
    expect(results.every((x) => x.ok)).toBe(true);
    expect(r.stats.loads).toBe(1);
  });

  it('is bounded by bytes: least recently used files are evicted, and an oversized file is never cached', async () => {
    const big = (c: string) => `${c.repeat(100)}\n`.repeat(10); // ~1 KB of text each, ~2 KB accounted
    for (const f of ['a', 'b', 'c']) put(`src/${f}.ts`, big(f));
    const r = new BodyReader(root, { maxBytes: 5_000 });
    const nodes = await Promise.all(['a', 'b', 'c'].map((f) => node(`src/${f}.ts`, 1, 1)));
    for (const n of nodes) await r.read(n);
    expect(r.cachedBytes).toBeLessThanOrEqual(5_000);
    expect(r.stats.loads).toBe(3);
    await r.read(nodes[0]!); // a was evicted by c: reload
    expect(r.stats.loads).toBe(4);

    put('src/huge.ts', 'x'.repeat(10_000));
    const h = await node('src/huge.ts', 1, 1);
    const before = r.cachedBytes;
    expect((await r.read(h)).ok).toBe(true);
    expect((await r.read(h)).ok).toBe(true);
    expect(r.cachedBytes).toBeLessThanOrEqual(5_000);
    expect(before).toBeLessThanOrEqual(5_000);
  });

  it('invalidate forgets a path or everything', async () => {
    put('src/a.ts', SRC);
    const r = new BodyReader(root);
    const n = await node('src/a.ts', 1, 1);
    await r.read(n);
    r.invalidate('src/a.ts');
    expect(r.cachedBytes).toBe(0);
    await r.read(n);
    expect(r.stats.loads).toBe(2);
    r.invalidate();
    expect(r.cachedBytes).toBe(0);
  });

  it('handles unicode and long lines', async () => {
    put('src/u.ts', 'const s = "héllo 世界 🚀";\n' + 'x'.repeat(50_000) + '\nend\n');
    const r = new BodyReader(root);
    expect(await r.read(await node('src/u.ts', 1, 1))).toEqual({ ok: true, text: 'const s = "héllo 世界 🚀";' });
    expect(((await r.read(await node('src/u.ts', 2, 3))) as { text: string }).text.length).toBe(50_004);
  });
});
