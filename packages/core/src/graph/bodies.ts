// PROMPTS 084: the code that goes into the context, read from the working tree at pack time (never stored in the graph),
// so what the agent sees is what is on disk right now.
//   - a node carries the hash of its file at index time; if the file on disk hashes differently the graph is stale for
//     this node, so we return { ok: false, reason: 'stale' } and tell the owner once (onStale) so it can re-index.
//     The packer then falls back to the signature instead of quoting lines that moved.
//   - files are cached as split lines in a byte-bounded LRU; a cheap stat (mtime + size) decides whether the cached
//     copy is still the file on disk, so a hot request costs one stat, not a read and a hash.
//   - content is normalised exactly like discovery (BOM stripped, CRLF → LF) before hashing, so Windows files match.

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { normaliseContent } from '../indexer/discover.js';
import type { GraphNode } from '../types.js';
import { blankCjkComments } from '../util/comments.js';
import { sha1 } from '../util/hash.js';

/** Per-repository opt-in: when this file exists the text of Chinese comments is blanked in the code Click returns (line numbers unchanged). */
export const BLANK_CJK_MARKER = join('.click', 'blank-cjk-comments');

/** The text to serve: the file as it is, or (opt-in) with Chinese comments blanked. The hash is always of the real file; a transform that changed the line count is dropped. */
function shown(content: string, blank: boolean): string {
  if (!blank) return content;
  const out = blankCjkComments(content);
  return out.split('\n').length === content.split('\n').length ? out : content;
}

export type BodyResult = { ok: true; text: string } | { ok: false; reason: 'stale' | 'missing' | 'unreadable' };

export interface BodyReaderOptions {
  /** Cache budget in bytes (default 32 MB). A file larger than the budget is read every time and never cached. */
  maxBytes?: number;
  /** Called once per path when its content stops matching the indexed hash; cleared when the path matches again. */
  onStale?: (path: string) => void;
  /** Honour the per-repository marker .click/blank-cjk-comments (blank Chinese comments). Only the daemon turns this on: the benchmark and every in-process caller see the code exactly as it is. */
  honorBlankMarker?: boolean;
}

interface Entry {
  mtimeMs: number;
  size: number;
  hash: string;
  /** Whether the lines went through blankCjkComments, so a marker added or removed later is not answered from a stale cache entry. */
  blanked: boolean;
  lines: string[];
  bytes: number;
}

export class BodyReader {
  private readonly cache = new Map<string, Entry>(); // insertion order = recency order
  private readonly inflight = new Map<string, Promise<Entry | 'missing' | 'unreadable'>>();
  private readonly reported = new Set<string>();
  private bytes = 0;
  private readonly maxBytes: number;
  private readonly onStale: ((path: string) => void) | undefined;
  private readonly honorBlankMarker: boolean;
  readonly stats = { hits: 0, loads: 0, stale: 0 };

  constructor(
    private readonly root: string,
    opts: BodyReaderOptions = {},
  ) {
    this.maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
    this.onStale = opts.onStale;
    this.honorBlankMarker = opts.honorBlankMarker ?? false;
  }

  /** Bytes currently held by the cache (never above maxBytes). */
  get cachedBytes(): number {
    return this.bytes;
  }

  async read(node: Pick<GraphNode, 'path' | 'range' | 'fileHash'>): Promise<BodyResult> {
    if (!node.path || !node.range) return { ok: false, reason: 'missing' };
    const entry = await this.load(node.path);
    if (entry === 'missing' || entry === 'unreadable') return { ok: false, reason: entry };
    if (entry.hash !== node.fileHash) {
      this.stats.stale++;
      if (!this.reported.has(node.path)) {
        this.reported.add(node.path);
        this.onStale?.(node.path);
      }
      return { ok: false, reason: 'stale' };
    }
    this.reported.delete(node.path);
    return { ok: true, text: entry.lines.slice(node.range.startLine - 1, node.range.endLine).join('\n') };
  }

  /** Read many nodes, loading each file once. Keys are node ids; nodes without a path or range are reported as missing. */
  async readMany(nodes: readonly (Pick<GraphNode, 'id' | 'path' | 'range' | 'fileHash'>)[]): Promise<Map<string, BodyResult>> {
    const results = await Promise.all(nodes.map((n) => this.read(n)));
    const out = new Map<string, BodyResult>(); // filled in input order, not completion order
    nodes.forEach((n, i) => out.set(n.id, results[i]!));
    return out;
  }

  /** Forget one path (after a re-index) or everything. */
  invalidate(path?: string): void {
    if (path === undefined) {
      this.cache.clear();
      this.bytes = 0;
      this.reported.clear();
      return;
    }
    this.drop(path);
    this.reported.delete(path);
  }

  private drop(path: string): void {
    const e = this.cache.get(path);
    if (e) {
      this.bytes -= e.bytes;
      this.cache.delete(path);
    }
  }

  private load(path: string): Promise<Entry | 'missing' | 'unreadable'> {
    const pending = this.inflight.get(path);
    if (pending) return pending; // concurrent readers of one file share one load
    const p = this.loadUncached(path).finally(() => this.inflight.delete(path));
    this.inflight.set(path, p);
    return p;
  }

  private async loadUncached(path: string): Promise<Entry | 'missing' | 'unreadable'> {
    const full = join(this.root, path);
    let st;
    try {
      st = await stat(full);
    } catch (e) {
      this.drop(path);
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
    }
    const blanked = this.honorBlankMarker && existsSync(join(this.root, BLANK_CJK_MARKER));
    const hit = this.cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.blanked === blanked) {
      this.stats.hits++;
      this.cache.delete(path); // refresh recency
      this.cache.set(path, hit);
      return hit;
    }
    let content: string;
    try {
      content = normaliseContent(await readFile(full, 'utf8'));
    } catch {
      this.drop(path);
      return 'unreadable'; // a directory, a permission problem, a file removed mid-read
    }
    this.stats.loads++;
    const entry: Entry = { mtimeMs: st.mtimeMs, size: st.size, hash: sha1(content), blanked, lines: shown(content, blanked).split('\n'), bytes: content.length * 2 };
    this.drop(path);
    if (entry.bytes <= this.maxBytes) {
      this.cache.set(path, entry);
      this.bytes += entry.bytes;
      for (const [k, v] of this.cache) {
        if (this.bytes <= this.maxBytes) break;
        if (k === path) continue;
        this.cache.delete(k);
        this.bytes -= v.bytes;
      }
    }
    return entry;
  }
}
