import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { EdgeKind, GraphEdge, GraphNode } from '../types.js';
import { Deadline } from '../util/deadline.js';
import { fetchJson, HttpError } from '../util/http.js';
import { sha1 } from '../util/hash.js';
import { clickDir } from '../util/paths.js';
import type { EdgeRow, GraphStore, ImpactOptions, NeighbourhoodOptions } from './types.js';

const EDGE_KINDS: EdgeKind[] = [
  'contains', 'imports', 'uses_component', 'passes_prop', 'emits_to', 'calls',
  'uses_store', 'uses_composable', 'routes_to', 'has_type', 'tested_by', 'co_changed',
];
const BATCH_SIZE = 1_000;
const PAGE_SIZE = 1_024;

export type HydraCell = { type: string; value: unknown };

interface HydraResponse {
  columns?: string[];
  rows?: HydraCell[][];
  query_id?: string;
  next_cursor?: number | null;
  error?: { code?: string; message?: string };
}

export interface HydraQueryOptions {
  signal?: AbortSignal;
  deadline?: Deadline;
  pageSize?: number;
}

export interface HydraDbGraphStoreOptions {
  url?: string;
  graphId?: string;
  namespace?: string;
  cellId?: string;
  token?: string;
  tokenFile?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class HydraQueryError extends Error {
  constructor(message: string, readonly code?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HydraQueryError';
  }
}

/** Stable non-negative 48-bit HydraDB vertex id for one Click string id. */
export function vid(id: string): number {
  return Number.parseInt(sha1(id).slice(0, 12), 16);
}

export function relationshipType(kind: EdgeKind): string {
  if (!EDGE_KINDS.includes(kind)) throw new Error(`unsupported edge kind: ${kind}`);
  return kind.toUpperCase();
}

export class HydraHttpClient {
  private readonly baseUrl: string;
  private readonly graphId: string;
  private readonly namespace: string;
  private readonly cellId: string;
  private readonly staticToken: string | undefined;
  private readonly tokenFile: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch | undefined;

  constructor(options: HydraDbGraphStoreOptions = {}) {
    this.baseUrl = (options.url ?? process.env.HYDRADB_URL ?? 'http://127.0.0.1:8443').replace(/\/$/, '');
    this.graphId = options.graphId ?? 'default';
    this.namespace = options.namespace ?? 'default';
    this.cellId = options.cellId ?? 'cell-0';
    this.staticToken = options.token ?? process.env.HYDRADB_TOKEN;
    this.tokenFile = options.tokenFile ?? process.env.HYDRADB_TOKEN_FILE ?? join(clickDir(), 'hydradb-token');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.doFetch = options.fetch;
  }

  async health(signal?: AbortSignal): Promise<{ ok: boolean; detail?: string }> {
    try {
      const response = await fetchJson<{ status?: string }>(`${this.baseUrl}/healthz`, {
        signal,
        timeoutMs: Math.min(this.timeoutMs, 2_000),
        retries: 0,
        fetch: this.doFetch,
      });
      return response?.status === 'ok' ? { ok: true } : { ok: false, detail: 'unexpected health response' };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async query(query: string, parameters: Record<string, unknown> = {}, options: HydraQueryOptions = {}): Promise<Record<string, unknown>[]> {
    const pageSize = options.pageSize ?? PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 4_096) throw new Error('HydraDB pageSize must be between 1 and 4096');
    const token = await this.token();
    const url = `${this.baseUrl}/v1/graphs/${encodeURIComponent(this.graphId)}/query`;
    const headers = {
      authorization: `Bearer ${token}`,
      'x-graph-namespace': this.namespace,
    };
    const original = { cell_id: this.cellId, query, parameters, page_size: pageSize };
    const rows: Record<string, unknown>[] = [];
    let cursor: number | null | undefined;
    let queryId: string | undefined;
    let pages = 0;
    do {
      if (++pages > 100_000) throw new HydraQueryError('HydraDB pagination exceeded 100000 pages');
      const body = cursor == null ? original : { ...original, cursor, query_id: queryId };
      const response = await this.request(url, headers, body, {
        ...options,
        // Cursors are consuming iterators: retrying a continuation silently skips a page.
        retries: cursor == null ? 3 : 0,
      });
      if (response.error) throw new HydraQueryError(response.error.message ?? 'HydraDB query failed', response.error.code);
      if (!Array.isArray(response.rows)) throw new HydraQueryError('HydraDB response did not contain rows');
      const columns = response.columns ?? response.rows[0]?.map((_cell, index) => String(index)) ?? [];
      for (const row of response.rows) rows.push(decodeRow(columns, row));
      cursor = response.next_cursor;
      queryId = response.query_id ?? queryId;
      if (cursor != null && !queryId) throw new HydraQueryError('HydraDB paginated response omitted query_id');
    } while (cursor != null);
    return rows;
  }

  private async request(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    options: HydraQueryOptions & { retries: number },
  ): Promise<HydraResponse> {
    try {
      return await fetchJson<HydraResponse>(url, {
        headers,
        body,
        signal: options.signal,
        deadline: options.deadline,
        timeoutMs: this.timeoutMs,
        retries: options.retries,
        fetch: this.doFetch,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        const message = serverMessage(error.body) ?? error.message;
        throw new HydraQueryError(message, error.status ? String(error.status) : error.code, { cause: error });
      }
      throw error;
    }
  }

  private async token(): Promise<string> {
    if (this.staticToken) return this.staticToken;
    let token: string;
    try {
      token = (await readFile(this.tokenFile, 'utf8')).trim();
    } catch (error) {
      throw new HydraQueryError(`cannot read HYDRADB token file: ${this.tokenFile}`, undefined, { cause: error });
    }
    if (!token) throw new HydraQueryError(`HYDRADB token file is empty: ${this.tokenFile}`);
    return token;
  }
}

export class HydraDbGraphStore implements GraphStore {
  readonly name = 'hydradb';
  readonly client: HydraHttpClient;

  constructor(options: HydraDbGraphStoreOptions = {}) {
    this.client = new HydraHttpClient(options);
  }

  health(signal?: AbortSignal): Promise<{ ok: boolean; version?: string; detail?: string }> {
    return this.client.health(signal);
  }

  async upsertGraph(batch: { nodes?: GraphNode[]; edges?: GraphEdge[] }, _indexVersion: string): Promise<void> {
    for (const nodes of chunks(batch.nodes ?? [], BATCH_SIZE)) {
      await this.client.query(NODE_UPSERT, { rows: nodes.map(nodeRow) });
    }
    const byKind = new Map<EdgeKind, GraphEdge[]>();
    for (const edge of batch.edges ?? []) {
      const group = byKind.get(edge.kind) ?? [];
      group.push(edge);
      byKind.set(edge.kind, group);
    }
    for (const kind of EDGE_KINDS) {
      for (const edges of chunks(byKind.get(kind) ?? [], BATCH_SIZE)) {
        const type = relationshipType(kind);
        const query = `UNWIND $rows AS row CREATE (a {id: row.src})-[:${type}]->(b {id: row.dst})`;
        await this.client.query(query, { rows: edges.map((edge) => ({ src: vid(edge.from), dst: vid(edge.to) })) });
      }
    }
  }

  async removeGraph(ids: { nodeIds?: string[]; edgeKeys?: string[] }): Promise<void> {
    for (const key of ids.edgeKeys ?? []) {
      const edge = parseEdgeKey(key);
      const type = relationshipType(edge.kind);
      await this.client.query(`MATCH (a {id: $src})-[r:${type}]->(b {id: $dst}) DELETE r`, {
        src: vid(edge.from), dst: vid(edge.to),
      });
    }
    for (const nodeIds of chunks(ids.nodeIds ?? [], BATCH_SIZE)) {
      await this.client.query('UNWIND $rows AS row MATCH (n {id: row.id}) DETACH DELETE n', {
        rows: nodeIds.map((id) => ({ id: vid(id) })),
      });
    }
  }

  async neighbourhood(_ids: string[], _opts: NeighbourhoodOptions, _signal?: AbortSignal): Promise<EdgeRow[]> {
    throw new Error('HydraDbGraphStore.neighbourhood is implemented in prompt 106');
  }

  async impact(_id: string, _opts: ImpactOptions, _signal?: AbortSignal): Promise<{ path: string[]; kinds: EdgeKind[] }[]> {
    throw new Error('HydraDbGraphStore.impact is implemented in prompt 106');
  }

  async hubs(_k: number, _signal?: AbortSignal): Promise<{ id: string; score: number }[]> {
    throw new Error('HydraDbGraphStore.hubs is implemented in prompt 106');
  }

  async setEdgeWeights(_updates: { key: string; w: number }[]): Promise<void> {
    throw new Error('HydraDbGraphStore.setEdgeWeights is implemented in prompt 106');
  }

  async *loadAll(): AsyncIterable<{ nodes?: GraphNode[]; edges?: GraphEdge[] }> {
    throw new Error('HydraDbGraphStore.loadAll is implemented in prompt 106');
  }
}

const NODE_UPSERT = `UNWIND $rows AS row MERGE (n {id: row.id})
SET n:CodeNode, n.key = row.key, n.kind = row.kind, n.name = row.name,
    n.path = row.path, n.startLine = row.startLine, n.endLine = row.endLine,
    n.signature = row.signature, n.fileHash = row.fileHash,
    n.tokens = row.tokens, n.sigTokens = row.sigTokens`;

function nodeRow(node: GraphNode): Record<string, unknown> {
  return {
    id: vid(node.id), key: node.id, kind: node.kind, name: node.name, path: node.path,
    startLine: node.range?.startLine ?? null, endLine: node.range?.endLine ?? null,
    signature: node.signature ?? null, fileHash: node.fileHash, tokens: node.tokens, sigTokens: node.sigTokens,
  };
}

function decodeRow(columns: string[], row: HydraCell[]): Record<string, unknown> {
  if (columns.length !== row.length) throw new HydraQueryError(`HydraDB row has ${row.length} cells for ${columns.length} columns`);
  return Object.fromEntries(row.map((cell, index) => [columns[index]!, decodeCell(cell)]));
}

export function decodeCell(cell: HydraCell): unknown {
  if (!cell || typeof cell !== 'object' || typeof cell.type !== 'string' || !('value' in cell)) {
    throw new HydraQueryError('HydraDB returned a malformed typed cell');
  }
  return cell.type === 'null' ? null : cell.value;
}

function parseEdgeKey(key: string): { from: string; kind: EdgeKind; to: string } {
  for (const kind of EDGE_KINDS) {
    const separator = `|${kind}|`;
    const at = key.indexOf(separator);
    if (at >= 0) return { from: key.slice(0, at), kind, to: key.slice(at + separator.length) };
  }
  throw new Error(`invalid edge key: ${key}`);
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function serverMessage(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message;
  } catch {
    return body.slice(0, 500);
  }
}
