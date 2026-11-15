// PROMPTS 080 / SPEC §7: the local copy of the graph that lets the daemon start in milliseconds.
//   <dir>/<version>.json.gz   { v:1, version, repoCommit, createdAt, profileHash, nodes, edges, chunks } (chunks without text)
//   <dir>/<version>.vec       optional chunk vectors (binary, see encodeVectors)
//   <dir>/CURRENT             the version string, replaced atomically (temp file + rename)
// Write order is vectors → snapshot → CURRENT, so CURRENT never points at something incomplete. The last `keep`
// versions are retained (CURRENT's version always survives). Orphan `*.tmp` files left by a crashed writer are
// ignored by every reader and swept after a grace period. Loading never throws: a missing, truncated or corrupt
// snapshot comes back as { ok: false } so the caller can pull from HydraDB or re-index.

import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import type { Graph } from '../types.js';
import { TEMP_SUFFIX, writeFileAtomic } from '../util/atomic.js';

const gz = promisify(gzip);
const gunz = promisify(gunzip);

export const SNAPSHOT_FORMAT = 1;
const SAFE_VERSION = /^[A-Za-z0-9_-]{1,64}$/; // CURRENT is file content: never let it point outside the directory
const TEMP_GRACE_MS = 10 * 60_000;

export interface SnapshotMeta {
  v: 1;
  version: string;
  repoCommit: string | null;
  createdAt: string;
  profileHash: string;
}

export interface VectorTable {
  dims: number;
  ids: string[];
  /** ids.length × dims floats, row-major. */
  data: Float32Array;
}

export interface WriteOptions {
  profileHash: string;
  createdAt?: Date;
  vectors?: VectorTable;
}

export type LoadResult =
  | { ok: true; graph: Graph; meta: SnapshotMeta; vectors: VectorTable | null; vectorsError?: string }
  | { ok: false; reason: 'none' | 'missing' | 'corrupt'; detail?: string };

// ---------------------------------------------------------------- vectors

const MAGIC = 0x43564543; // "CVEC" little-endian
const HEADER_BYTES = 16; // magic, dims, count, idsByteLength

/** Binary layout: u32 magic, u32 dims, u32 count, u32 idsLen, ids (UTF-8, '\n'-separated, padded to 4 bytes), f32[count × dims]. */
export function encodeVectors(t: VectorTable): Buffer {
  if (t.data.length !== t.ids.length * t.dims) throw new Error(`vector data has ${t.data.length} floats, expected ${t.ids.length} × ${t.dims}`);
  if (t.ids.some((id) => id.includes('\n'))) throw new Error('vector ids must not contain newlines');
  const ids = Buffer.from(t.ids.join('\n'), 'utf8');
  const padded = Math.ceil(ids.length / 4) * 4;
  const out = Buffer.alloc(HEADER_BYTES + padded + t.data.byteLength);
  out.writeUInt32LE(MAGIC, 0);
  out.writeUInt32LE(t.dims, 4);
  out.writeUInt32LE(t.ids.length, 8);
  out.writeUInt32LE(ids.length, 12);
  ids.copy(out, HEADER_BYTES);
  Buffer.from(t.data.buffer, t.data.byteOffset, t.data.byteLength).copy(out, HEADER_BYTES + padded);
  return out;
}

export function decodeVectors(buf: Buffer): VectorTable {
  if (buf.length < HEADER_BYTES || buf.readUInt32LE(0) !== MAGIC) throw new Error('not a vector file');
  const dims = buf.readUInt32LE(4);
  const count = buf.readUInt32LE(8);
  const idsLen = buf.readUInt32LE(12);
  const padded = Math.ceil(idsLen / 4) * 4;
  const expected = HEADER_BYTES + padded + count * dims * 4;
  if (buf.length !== expected) throw new Error(`vector file is ${buf.length} bytes, expected ${expected}`);
  const idText = buf.subarray(HEADER_BYTES, HEADER_BYTES + idsLen).toString('utf8');
  const ids = count === 0 ? [] : idText.split('\n');
  if (ids.length !== count) throw new Error(`vector file lists ${ids.length} ids for ${count} rows`);
  const data = new Float32Array(count * dims);
  Buffer.from(data.buffer).set(buf.subarray(HEADER_BYTES + padded)); // copies, so alignment of `buf` never matters
  return { dims, ids, data };
}

// ---------------------------------------------------------------- store

/**
 * `click push` / `click pull` (Lane A) write `{ v: 1, graph, chunks }` with chunk TEXT under the same file name; the daemon
 * writes that format too, so there is one format on disk. Read it here: the graph's chunks are the records without text.
 */
function fromPushShape(o: Record<string, unknown>, version: string): Record<string, unknown> | null {
  const g = o.graph as { version?: unknown; repoCommit?: unknown; nodes?: unknown; edges?: unknown } | undefined;
  if (o.v !== 1 || !g || typeof g !== 'object' || !Array.isArray(o.chunks) || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;
  const chunks = (o.chunks as { id: string; nodeId: string; path: string; range: unknown }[]).map(({ id, nodeId, path, range }) => ({ id, nodeId, path, range }));
  return { v: SNAPSHOT_FORMAT, version: g.version ?? version, repoCommit: g.repoCommit ?? null, createdAt: '', profileHash: '', nodes: g.nodes, edges: g.edges, chunks };
}

function checkShape(x: unknown, version: string): SnapshotMeta & { nodes: Graph['nodes']; edges: Graph['edges']; chunks: Graph['chunks'] } {
  let o = x as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') throw new Error('not an object');
  if (o.graph !== undefined) o = fromPushShape(o, version) ?? o;
  if (o.v !== SNAPSHOT_FORMAT) throw new Error(`unsupported snapshot format ${String(o.v)}`);
  if (o.version !== version) throw new Error(`snapshot says version ${String(o.version)}, file name says ${version}`);
  if (!Array.isArray(o.nodes) || !Array.isArray(o.edges) || !Array.isArray(o.chunks)) throw new Error('nodes, edges and chunks must be arrays');
  if (typeof o.createdAt !== 'string' || typeof o.profileHash !== 'string') throw new Error('missing createdAt / profileHash');
  return o as never;
}

export class SnapshotStore {
  constructor(
    readonly dir: string,
    private readonly keep = 3,
    private readonly now: () => number = Date.now,
  ) {}

  private snap = (version: string): string => join(this.dir, `${version}.json.gz`);
  private vec = (version: string): string => join(this.dir, `${version}.vec`);
  private currentFile = (): string => join(this.dir, 'CURRENT');

  async write(graph: Graph, opts: WriteOptions): Promise<void> {
    if (!SAFE_VERSION.test(graph.version)) throw new Error(`unsafe graph version "${graph.version}"`);
    const meta: SnapshotMeta = { v: SNAPSHOT_FORMAT, version: graph.version, repoCommit: graph.repoCommit, createdAt: (opts.createdAt ?? new Date(this.now())).toISOString(), profileHash: opts.profileHash };
    if (opts.vectors) await writeFileAtomic(this.vec(graph.version), encodeVectors(opts.vectors));
    const body = JSON.stringify({ ...meta, nodes: graph.nodes, edges: graph.edges, chunks: graph.chunks });
    await writeFileAtomic(this.snap(graph.version), await gz(Buffer.from(body, 'utf8')));
    await writeFileAtomic(this.currentFile(), graph.version);
    await this.prune(graph.version);
  }

  async currentVersion(): Promise<string | null> {
    try {
      const v = (await readFile(this.currentFile(), 'utf8')).trim();
      return SAFE_VERSION.test(v) ? v : null;
    } catch {
      return null;
    }
  }

  /** Load `version`, or whatever CURRENT points at. Never throws. */
  async load(version?: string): Promise<LoadResult> {
    const v = version ?? (await this.currentVersion());
    if (!v || !SAFE_VERSION.test(v)) return { ok: false, reason: 'none' };
    let raw: Buffer;
    try {
      raw = await readFile(this.snap(v));
    } catch {
      return { ok: false, reason: 'missing', detail: `${v}.json.gz` };
    }
    let parsed: ReturnType<typeof checkShape>;
    try {
      parsed = checkShape(JSON.parse((await gunz(raw)).toString('utf8')), v);
    } catch (e) {
      return { ok: false, reason: 'corrupt', detail: e instanceof Error ? e.message : String(e) };
    }
    const { nodes, edges, chunks, ...meta } = parsed;
    const graph: Graph = { version: v, repoCommit: meta.repoCommit, nodes, edges, chunks };
    let vectors: VectorTable | null = null;
    let vectorsError: string | undefined;
    try {
      vectors = decodeVectors(await readFile(this.vec(v)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') vectorsError = e instanceof Error ? e.message : String(e); // a bad .vec never loses the graph
    }
    return { ok: true, graph, meta: meta as SnapshotMeta, vectors, ...(vectorsError ? { vectorsError } : {}) };
  }

  /** Snapshot versions on disk, newest first (by modification time). Temp files are not versions. */
  async versions(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const found: { v: string; t: number }[] = [];
    for (const n of names) {
      if (!n.endsWith('.json.gz') || TEMP_SUFFIX.test(n)) continue;
      const v = n.slice(0, -'.json.gz'.length);
      if (!SAFE_VERSION.test(v)) continue;
      try {
        found.push({ v, t: (await stat(join(this.dir, n))).mtimeMs });
      } catch {
        // vanished between readdir and stat
      }
    }
    return found.sort((a, b) => b.t - a.t || (a.v < b.v ? -1 : 1)).map((f) => f.v);
  }

  /** Keep the newest `keep` versions plus `current`; delete the rest, and temp files older than the grace period. */
  private async prune(current: string): Promise<void> {
    const keepSet = new Set([current, ...(await this.versions()).slice(0, this.keep)]);
    for (const v of await this.versions()) {
      if (keepSet.has(v)) continue;
      await rm(this.snap(v), { force: true });
      await rm(this.vec(v), { force: true });
    }
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!TEMP_SUFFIX.test(n)) continue;
      try {
        if (this.now() - (await stat(join(this.dir, n))).mtimeMs > TEMP_GRACE_MS) await rm(join(this.dir, n), { force: true });
      } catch {
        // already gone
      }
    }
  }
}
