import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Graph } from '../types.js';
import { SnapshotStore, decodeVectors, encodeVectors, type VectorTable } from './snapshot.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'click-snap-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const graph = (version: string, extra = 0): Graph => ({
  version,
  repoCommit: 'a'.repeat(40),
  nodes: [
    { id: 'file:a.ts', kind: 'file', path: 'a.ts', name: 'a.ts', range: { startLine: 1, endLine: 3 }, tokens: 10, sigTokens: 0, fileHash: 'h1' },
    { id: 'sym:a.ts#f', kind: 'function', path: 'a.ts', name: 'f', range: { startLine: 1, endLine: 3 }, signature: 'export function f() { … }', tokens: 8, sigTokens: 5, fileHash: 'h1', meta: { exported: true, e: 'é世界' } },
    ...Array.from({ length: extra }, (_, i) => ({ id: `sym:a.ts#g${i}`, kind: 'function' as const, path: 'a.ts', name: `g${i}`, tokens: 1, sigTokens: 0, fileHash: 'h1' })),
  ],
  edges: [{ key: 'file:a.ts|contains|sym:a.ts#f', from: 'file:a.ts', to: 'sym:a.ts#f', kind: 'contains', meta: { source: 'ast' } }],
  chunks: [{ id: 'chunk:a.ts#f#0', nodeId: 'sym:a.ts#f', path: 'a.ts', range: { startLine: 1, endLine: 3 } }],
});
const vectors = (ids: string[], dims = 4): VectorTable => ({ dims, ids, data: Float32Array.from({ length: ids.length * dims }, (_, i) => i / 7 - 1) });
const FIXED = new Date('2026-11-15T10:00:00.000Z');

describe('SnapshotStore (PROMPTS 080)', () => {
  it('round-trips a graph exactly, with metadata, and points CURRENT at it', async () => {
    const s = new SnapshotStore(dir);
    expect(await s.load()).toEqual({ ok: false, reason: 'none' });
    await s.write(graph('v1'), { profileHash: 'ph', createdAt: FIXED });
    expect(readFileSync(join(dir, 'CURRENT'), 'utf8')).toBe('v1');
    const r = await s.load();
    expect(r).toMatchObject({ ok: true, vectors: null, meta: { v: 1, version: 'v1', profileHash: 'ph', createdAt: FIXED.toISOString(), repoCommit: 'a'.repeat(40) } });
    if (r.ok) expect(r.graph).toEqual(graph('v1'));
  });

  it('stores vectors next to the graph and round-trips them bit for bit', async () => {
    const s = new SnapshotStore(dir);
    const v = vectors(['chunk:a.ts#f#0', 'chunk:b.ts#é#1', 'chunk:c.ts#x#2'], 5);
    await s.write(graph('v1'), { profileHash: 'ph', vectors: v });
    const r = await s.load();
    expect(r.ok && r.vectors).toEqual(v);
    expect(r.ok && Array.from(r.vectors!.data)).toEqual(Array.from(v.data));
  });

  it('keeps the newest N versions and always the current one; removes the vectors of pruned versions', async () => {
    const s = new SnapshotStore(dir, 3);
    for (let i = 1; i <= 6; i++) {
      await s.write(graph(`v${i}`, i), { profileHash: 'ph', vectors: vectors(['c'], 2) });
      const t = new Date(FIXED.getTime() + i * 1000); // distinct, increasing mtimes
      utimesSync(join(dir, `v${i}.json.gz`), t, t);
    }
    // the last write ran prune before the loop touched mtimes; write once more to prune with ordered mtimes
    await s.write(graph('v7', 7), { profileHash: 'ph' });
    const files = readdirSync(dir).sort();
    expect(files.filter((f) => f.endsWith('.json.gz')).length).toBeLessThanOrEqual(4); // keep 3 + current
    expect(files).toContain('v7.json.gz');
    expect(files).toContain('CURRENT');
    expect(await s.currentVersion()).toBe('v7');
    for (const f of files.filter((x) => x.endsWith('.vec'))) expect(files).toContain(f.replace('.vec', '.json.gz')); // no orphan vectors
  });

  it('ignores a temp file left behind by a crashed writer, and sweeps it after the grace period', async () => {
    let clock = FIXED.getTime();
    const s = new SnapshotStore(dir, 3, () => clock);
    await s.write(graph('v1'), { profileHash: 'ph', createdAt: FIXED });
    const tmp = join(dir, 'v2.json.gz.4242.deadbeef.tmp');
    writeFileSync(tmp, 'partial garbage');
    utimesSync(tmp, FIXED, FIXED);
    expect(await s.versions()).toEqual(['v1']); // the temp file is not a version
    expect((await s.load()).ok).toBe(true);
    clock += 60 * 60_000; // an hour later
    await s.write(graph('v2'), { profileHash: 'ph' });
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('a CURRENT that was never replaced keeps pointing at the last complete snapshot', async () => {
    const s = new SnapshotStore(dir);
    await s.write(graph('v1'), { profileHash: 'ph' });
    writeFileSync(join(dir, 'v2.json.gz'), gzipSync('{"half'));
    writeFileSync(join(dir, 'CURRENT.9.cafebabe.tmp'), 'v2'); // a writer died before the rename
    expect(await s.currentVersion()).toBe('v1');
    expect((await s.load()).ok).toBe(true);
  });

  it('reports a missing or corrupt snapshot instead of throwing', async () => {
    const s = new SnapshotStore(dir);
    writeFileSync(join(dir, 'CURRENT'), 'v9');
    expect(await s.load()).toMatchObject({ ok: false, reason: 'missing' });
    writeFileSync(join(dir, 'v9.json.gz'), 'not gzip at all');
    expect(await s.load()).toMatchObject({ ok: false, reason: 'corrupt' });
    writeFileSync(join(dir, 'v9.json.gz'), gzipSync('{"v":1,"version":"other","nodes":[],"edges":[],"chunks":[],"createdAt":"x","profileHash":"y"}'));
    expect(await s.load('v9')).toMatchObject({ ok: false, reason: 'corrupt', detail: expect.stringContaining('other') });
    writeFileSync(join(dir, 'v9.json.gz'), gzipSync('{"v":2}'));
    expect(await s.load('v9')).toMatchObject({ ok: false, reason: 'corrupt', detail: expect.stringContaining('format') });
  });

  it('a corrupt .vec never loses the graph', async () => {
    const s = new SnapshotStore(dir);
    await s.write(graph('v1'), { profileHash: 'ph', vectors: vectors(['a', 'b']) });
    writeFileSync(join(dir, 'v1.vec'), Buffer.from('definitely not vectors'));
    const r = await s.load();
    expect(r).toMatchObject({ ok: true, vectors: null });
    expect(r.ok && r.vectorsError).toContain('not a vector file');
  });

  it('refuses path-traversal versions in CURRENT and in write()', async () => {
    const s = new SnapshotStore(dir);
    writeFileSync(join(dir, 'CURRENT'), '../../etc/passwd');
    expect(await s.currentVersion()).toBeNull();
    expect(await s.load()).toEqual({ ok: false, reason: 'none' });
    await expect(s.write(graph('../evil'), { profileHash: 'ph' })).rejects.toThrow(/unsafe/);
  });

  it('writing the same version twice is fine', async () => {
    const s = new SnapshotStore(dir);
    await s.write(graph('v1'), { profileHash: 'a' });
    await s.write(graph('v1'), { profileHash: 'b' });
    expect(await s.load()).toMatchObject({ ok: true, meta: { profileHash: 'b' } });
    expect(await s.versions()).toEqual(['v1']);
  });

  it('is much smaller on disk than the JSON (gzip) and loads a large graph quickly', async () => {
    const s = new SnapshotStore(dir);
    const big = graph('vbig', 20_000);
    await s.write(big, { profileHash: 'ph' });
    const size = readFileSync(join(dir, 'vbig.json.gz')).length;
    expect(size).toBeLessThan(JSON.stringify(big).length / 4);
    const t = performance.now();
    const r = await s.load();
    expect(r.ok && r.graph.nodes.length).toBe(20_002);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe('vector encoding', () => {
  it('round-trips, including empty tables, unicode ids and ids that are not a multiple of 4 bytes', () => {
    for (const ids of [[], ['a'], ['ab', 'abc', 'é世'], Array.from({ length: 50 }, (_, i) => `chunk:src/f${i}.ts#sym${i}#${i}`)]) {
      const t = vectors(ids, 3);
      const back = decodeVectors(encodeVectors(t));
      expect(back).toEqual(t);
    }
  });
  it('rejects mismatched data, newlines in ids, truncation and bad magic', () => {
    expect(() => encodeVectors({ dims: 2, ids: ['a'], data: new Float32Array(3) })).toThrow(/expected 1 × 2/);
    expect(() => encodeVectors({ dims: 1, ids: ['a\nb'], data: new Float32Array(1) })).toThrow(/newline/);
    const ok = encodeVectors(vectors(['a', 'b']));
    expect(() => decodeVectors(ok.subarray(0, ok.length - 1))).toThrow(/bytes, expected/);
    expect(() => decodeVectors(Buffer.from('xxxxxxxxxxxxxxxxxxxx'))).toThrow(/not a vector file/);
  });
});
