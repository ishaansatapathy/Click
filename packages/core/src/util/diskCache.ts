import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { sha1 } from './hash.js';
import { clickDir } from './paths.js';

// SPEC §17.2: `.click/cache/<ns>/<k0k1>/<key>.json`. Used for extract, embed, rerank, jev and llm caches.

export class CacheMiss extends Error {
  constructor(
    readonly ns: string,
    readonly key: string,
  ) {
    super(`cache miss (cache-only mode): ${ns}/${key}`);
    this.name = 'CacheMiss';
  }
}

export interface DiskCacheOptions {
  /** Cache root. Defaults to `<clickDir>/cache`. */
  dir?: string;
  /** A miss throws CacheMiss. Defaults to the CLICK_CACHE_ONLY env var. */
  cacheOnly?: boolean;
}

const NS_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_KEY_RE = /^[A-Za-z0-9_-]{2,128}$/;

const isTruthy = (v: string | undefined): boolean => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';

export class DiskCache {
  private readonly base: string;
  private readonly cacheOnlyOpt: boolean | undefined;

  constructor(
    readonly ns: string,
    opts: DiskCacheOptions = {},
  ) {
    if (!NS_RE.test(ns)) throw new Error(`invalid cache namespace: ${ns}`);
    this.base = join(opts.dir ?? join(clickDir(), 'cache'), ns);
    this.cacheOnlyOpt = opts.cacheOnly;
  }

  private get cacheOnly(): boolean {
    return this.cacheOnlyOpt ?? isTruthy(process.env.CLICK_CACHE_ONLY);
  }

  private fileFor(key: string): string {
    const k = SAFE_KEY_RE.test(key) ? key : sha1(key); // arbitrary strings become a safe file name
    return join(this.base, k.slice(0, 2), `${k}.json`);
  }

  /** Never throws on a miss: use for probing, even in cache-only mode. */
  async peek<T>(key: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.fileFor(key), 'utf8')) as T;
    } catch {
      return undefined; // missing, unreadable or corrupt: all count as a miss
    }
  }

  /** Cached value, or undefined on a miss. In cache-only mode a miss throws CacheMiss instead. */
  async get<T>(key: string): Promise<T | undefined> {
    const v = await this.peek<T>(key);
    if (v === undefined && this.cacheOnly) throw new CacheMiss(this.ns, key);
    return v;
  }

  /** Atomic write: temp file in the same directory, then rename over the target. */
  async set(key: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError('DiskCache.set: value is not JSON-serialisable');
    await writeFileAtomic(this.fileFor(key), json);
  }

  /** Cached value, or compute and store it. In cache-only mode a miss throws instead of computing. */
  async getOrCompute<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await compute();
    await this.set(key, value);
    return value;
  }
}
