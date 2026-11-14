import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CacheMiss, DiskCache } from './diskCache.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'click-cache-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function allFiles(d: string): string[] {
  return readdirSync(d, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

describe('DiskCache', () => {
  it('round-trips JSON and lays files out as <ns>/<k0k1>/<key>.json', async () => {
    const c = new DiskCache('extract', { dir, cacheOnly: false });
    await c.set('abcdef123456', { a: [1, 2], b: 'x' });
    expect(await c.get('abcdef123456')).toEqual({ a: [1, 2], b: 'x' });
    expect(allFiles(dir)).toEqual([join(dir, 'extract', 'ab', 'abcdef123456.json')]);
  });

  it('returns undefined on a miss and treats corrupt files as a miss', async () => {
    const c = new DiskCache('llm', { dir, cacheOnly: false });
    expect(await c.get('nope1234')).toBeUndefined();
    mkdirSync(join(dir, 'llm', 'bd'), { recursive: true });
    writeFileSync(join(dir, 'llm', 'bd', 'bad12345.json'), '{"half":');
    expect(await c.get('bad12345')).toBeUndefined();
  });

  it('keeps falsy values distinct from a miss', async () => {
    const c = new DiskCache('embed', { dir, cacheOnly: false });
    await c.set('k-null-1', null);
    await c.set('k-zero-1', 0);
    expect(await c.get('k-null-1')).toBeNull();
    expect(await c.get('k-zero-1')).toBe(0);
  });

  it('hashes unsafe keys into safe file names', async () => {
    const c = new DiskCache('jev', { dir, cacheOnly: false });
    await c.set('task: add ../../etc/passwd | "quoted"', { ok: true });
    expect(await c.get('task: add ../../etc/passwd | "quoted"')).toEqual({ ok: true });
    for (const f of allFiles(dir)) expect(f.startsWith(dir)).toBe(true);
  });

  it('rejects bad namespaces and unserialisable values', async () => {
    expect(() => new DiskCache('../evil', { dir })).toThrow();
    const c = new DiskCache('rerank', { dir, cacheOnly: false });
    await expect(c.set('key12345', undefined)).rejects.toThrow(TypeError);
  });

  it('writes atomically: concurrent writers and readers never see a partial file', async () => {
    const c = new DiskCache('extract', { dir, cacheOnly: false });
    const big = (n: number) => ({ n, pad: 'x'.repeat(50_000) });
    let torn = 0;
    const writers = Array.from({ length: 40 }, (_, i) => c.set('shared-key', big(i)));
    const readers = Array.from({ length: 80 }, async () => {
      for (let i = 0; i < 5; i++) {
        const text = await c.peek<{ n: number; pad: string }>('shared-key');
        if (text !== undefined && text.pad.length !== 50_000) torn++;
      }
    });
    await Promise.all([...writers, ...readers]);
    expect(torn).toBe(0);
    expect(allFiles(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]); // no leftovers
    expect((await c.get<{ n: number }>('shared-key'))?.n).toBeGreaterThanOrEqual(0);
  });

  it('ignores a temp file left behind by a crashed writer', async () => {
    const c = new DiskCache('extract', { dir, cacheOnly: false });
    mkdirSync(join(dir, 'extract', 'cr'), { recursive: true });
    writeFileSync(join(dir, 'extract', 'cr', 'crash1234.json.999.deadbeef.tmp'), '{"partial"');
    expect(await c.get('crash1234')).toBeUndefined();
    await c.set('crash1234', { fine: true });
    expect(await c.get('crash1234')).toEqual({ fine: true });
  });

  describe('cache-only mode', () => {
    it('throws CacheMiss on a miss but still serves hits', async () => {
      await new DiskCache('llm', { dir, cacheOnly: false }).set('hit-key-1', { v: 1 });
      const c = new DiskCache('llm', { dir, cacheOnly: true });
      expect(await c.get('hit-key-1')).toEqual({ v: 1 });
      await expect(c.get('miss-key-1')).rejects.toBeInstanceOf(CacheMiss);
      expect(await c.peek('miss-key-1')).toBeUndefined(); // peek never throws
    });
    it('never computes on a miss', async () => {
      const c = new DiskCache('llm', { dir, cacheOnly: true });
      let computed = false;
      await expect(c.getOrCompute('miss-key-2', async () => ((computed = true), 1))).rejects.toBeInstanceOf(CacheMiss);
      expect(computed).toBe(false);
    });
    it('is switched on by CLICK_CACHE_ONLY=1', async () => {
      const prev = process.env.CLICK_CACHE_ONLY;
      process.env.CLICK_CACHE_ONLY = '1';
      try {
        await expect(new DiskCache('llm', { dir }).get('miss-key-3')).rejects.toBeInstanceOf(CacheMiss);
      } finally {
        if (prev === undefined) delete process.env.CLICK_CACHE_ONLY;
        else process.env.CLICK_CACHE_ONLY = prev;
      }
    });
  });

  it('getOrCompute computes once, then serves from disk', async () => {
    const c = new DiskCache('embed', { dir, cacheOnly: false });
    let calls = 0;
    const f = async () => ({ calls: ++calls });
    expect(await c.getOrCompute('compute-1', f)).toEqual({ calls: 1 });
    expect(await c.getOrCompute('compute-1', f)).toEqual({ calls: 1 });
    expect(calls).toBe(1);
  });
});
