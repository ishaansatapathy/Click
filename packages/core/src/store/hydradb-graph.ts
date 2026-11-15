import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { EdgeKind, GraphEdge, GraphNode } from '../types.js';
import { Deadline } from '../util/deadline.js';
import { fetchJson, HttpError, netCounter } from '../util/http.js';
import { sha1 } from '../util/hash.js';
import { edgeKey } from '../util/ids.js';
import { clickDir } from '../util/paths.js';
import type { EdgeRow, GraphStore, ImpactOptions, NeighbourhoodOptions } from './types.js';

export const EDGE_KINDS: EdgeKind[] = [
  'contains', 'imports', 'uses_component', 'passes_prop', 'emits_to', 'calls',
  'uses_store', 'uses_composable', 'routes_to', 'has_type', 'tested_by', 'co_changed',
];
const BATCH_SIZE = 1_000;
const PAGE_SIZE = 1_024;
const META_ID = vid('click:graph-metadata');

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
  /** Suppress the per-HTTP logical count when an operation has already counted its aggregate call. */
  countLogical?: boolean;
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
        countLogical: options.countLogical,
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
  private indexVersion: string | undefined;
  private projectedVersion: string | undefined;
  private readonly hubCache = new Map<number, { id: string; score: number }[]>();

  constructor(options: HydraDbGraphStoreOptions = {}) {
    this.client = new HydraHttpClient(options);
  }

  health(signal?: AbortSignal): Promise<{ ok: boolean; version?: string; detail?: string }> {
    return this.client.health(signal);
  }

  async upsertGraph(batch: { nodes?: GraphNode[]; edges?: GraphEdge[] }, indexVersion: string): Promise<void> {
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
    await mapConcurrent((batch.edges ?? []).filter((edge) => edge.meta !== undefined), 8, async (edge) => {
      await this.client.query(
        `MATCH (a {id: $src})-[r:${relationshipType(edge.kind)}]->(b {id: $dst}) SET r.metaJson = $metaJson`,
        { src: vid(edge.from), dst: vid(edge.to), metaJson: JSON.stringify(edge.meta) },
      );
    });
    this.indexVersion = indexVersion;
    this.projectedVersion = undefined;
    this.hubCache.clear();
    await this.client.query(
      'UNWIND $rows AS row MERGE (n {id: row.id}) SET n:ClickMeta, n.indexVersion = row.version',
      { rows: [{ id: META_ID, version: indexVersion }] },
    );
  }

  async getIndexVersion(signal?: AbortSignal): Promise<string | null> {
    const rows = await this.client.query(
      'MATCH (n:ClickMeta {id: $id}) RETURN n.indexVersion AS version LIMIT 1',
      { id: META_ID }, { signal },
    );
    if (!rows.length || rows[0]!.version === null) return null;
    const version = requiredString(rows[0]!.version, 'indexVersion');
    this.indexVersion = version;
    return version;
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
    this.projectedVersion = undefined;
    this.hubCache.clear();
  }

  async neighbourhood(ids: string[], opts: NeighbourhoodOptions, signal?: AbortSignal): Promise<EdgeRow[]> {
    if (ids.length === 0) return [];
    const kinds = opts.kinds ?? EDGE_KINDS;
    assertEdgeKinds(kinds);
    netCounter.call();
    const relTypes = kinds.map((kind) => cypherString(relationshipType(kind))).join(',');
    const maxEdges = opts.maxEdges ?? 2_000;
    const pathCount = Math.min(maxEdges, 500);
    const parts = await Promise.all(ids.map((id) => this.client.query(
      `CALL algo.SSpaths({sourceNode: ${vid(id)}, relTypes: [${relTypes}], relDirection: 'both', maxLen: ${opts.hops}, pathCount: ${pathCount}}) YIELD path RETURN path`,
      {}, { signal, countLogical: false },
    )));
    const decoded = new Map<string, EdgeRow>();
    for (const row of parts.flat()) {
      for (const edge of decodePathEdges(row.path)) decoded.set(edgeKey(edge.from, edge.kind, edge.to), edge);
    }
    const seeds = new Set(ids);
    const first = [...decoded.values()].filter((edge) => seeds.has(edge.from) || seeds.has(edge.to));
    if (opts.hops === 1) return first.slice(0, maxEdges);
    const frontier = new Set(first.flatMap((edge) => [edge.from, edge.to])
      .filter((id) => !seeds.has(id))
      .slice(0, opts.maxFrontier ?? Infinity));
    return [...decoded.values()]
      .filter((edge) => seeds.has(edge.from) || seeds.has(edge.to) || frontier.has(edge.from) || frontier.has(edge.to))
      .slice(0, maxEdges);
  }

  async impact(id: string, opts: ImpactOptions, signal?: AbortSignal): Promise<{ path: string[]; kinds: EdgeKind[] }[]> {
    const kinds = opts.kinds ?? EDGE_KINDS;
    assertEdgeKinds(kinds);
    if (!Number.isInteger(opts.maxHops) || opts.maxHops < 1) return [];
    const limit = opts.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1) return [];
    const relTypes = kinds.map((kind) => `'${relationshipType(kind)}'`).join(',');
    const rows = await this.client.query(
      `CALL algo.SSpaths({sourceNode: ${vid(id)}, relTypes: [${relTypes}], relDirection: 'incoming', maxLen: ${opts.maxHops}, pathCount: ${limit}}) YIELD path RETURN path`,
      {}, { signal },
    );
    return rows.map((row) => decodeImpactPath(row.path, id))
      .filter((path) => path.path.length > 1)
      .sort((a, b) => a.path.length - b.path.length)
      .slice(0, limit);
  }

  async hubs(k: number, signal?: AbortSignal): Promise<{ id: string; score: number }[]> {
    if (!Number.isInteger(k) || k < 1) return [];
    const cached = this.hubCache.get(k);
    if (cached && this.projectedVersion === this.indexVersion) return structuredClone(cached);
    const version = this.indexVersion ?? 'unknown';
    if (this.projectedVersion !== version) {
      const graphName = `code_${sha1(version).slice(0, 12)}`;
      // HydraDB has no index generation for relationship types that have never been written;
      // including one makes graph.project fail, so discover the non-empty types first.
      const present = await Promise.all(EDGE_KINDS.map(async (kind) => {
        const type = relationshipType(kind);
        const rows = await this.client.query(`MATCH (a:CodeNode)-[:${type}]->(b) RETURN a.id AS id LIMIT 1`, {}, { signal });
        return rows.length ? type : undefined;
      }));
      const types = present.filter((type): type is string => type !== undefined).map((type) => `'${type}'`).join(',');
      try {
        await this.client.query(`CALL gds.graph.project('${graphName}', 'CodeNode', [${types}])`, {}, { signal });
      } catch (error) {
        // A new process may reuse the projection for the same immutable index version.
        if (!(error instanceof HydraQueryError) || !error.message.includes('already exists')) throw error;
      }
      await this.client.query(`CALL gds.pageRank.write('${graphName}', {maxIterations: 100, dampingFactor: 0.85, tolerance: 0.0001, writeProperty: 'pr'})`, {}, { signal });
      this.projectedVersion = version;
      this.hubCache.clear();
    }
    const rows = await this.client.query(
      'MATCH (n:CodeNode) RETURN n.key AS id, n.pr AS score ORDER BY score DESC LIMIT $k',
      { k }, { signal },
    );
    const result = rows.map((row) => ({ id: requiredString(row.id, 'id'), score: requiredNumber(row.score, 'score') }));
    this.hubCache.set(k, result);
    return structuredClone(result);
  }

  async setEdgeWeights(updates: { key: string; w: number }[]): Promise<void> {
    await mapConcurrent(updates, 8, async (update) => {
      if (!Number.isFinite(update.w)) throw new Error(`invalid edge weight for ${update.key}`);
      const edge = parseEdgeKey(update.key);
      await this.client.query(
        `MATCH (a {id: $src})-[r:${relationshipType(edge.kind)}]->(b {id: $dst}) SET r.w = $w`,
        { src: vid(edge.from), dst: vid(edge.to), w: update.w },
      );
    });
  }

  async *loadAll(): AsyncIterable<{ nodes?: GraphNode[]; edges?: GraphEdge[] }> {
    const rows = await this.client.query(
      'MATCH (n:CodeNode) RETURN n.key AS id, n.kind AS kind, n.path AS path, n.hasPath AS hasPath, n.name AS name, n.startLine AS startLine, n.endLine AS endLine, n.hasRange AS hasRange, n.signature AS signature, n.hasSignature AS hasSignature, n.doc AS doc, n.hasDoc AS hasDoc, n.metaJson AS metaJson, n.hasMeta AS hasMeta, n.fileHash AS fileHash, n.tokens AS tokens, n.sigTokens AS sigTokens',
      {}, { pageSize: PAGE_SIZE },
    );
    for (const page of chunks(rows, PAGE_SIZE)) yield { nodes: page.map(decodeNode) };
    for (const kind of EDGE_KINDS) {
      const type = relationshipType(kind);
      const edgeRows = await this.client.query(
        `MATCH (a:CodeNode)-[r:${type}]->(b) RETURN a.key AS src, b.key AS dst, r.metaJson AS metaJson`,
        {}, { pageSize: PAGE_SIZE },
      );
      for (const page of chunks(edgeRows, PAGE_SIZE)) {
        yield { edges: page.map((row) => {
          const from = requiredString(row.src, 'src');
          const to = requiredString(row.dst, 'dst');
          const meta = row.metaJson === null ? undefined : JSON.parse(requiredString(row.metaJson, 'metaJson')) as GraphEdge['meta'];
          return { key: edgeKey(from, kind, to), from, to, kind, ...(meta === undefined ? {} : { meta }) };
        }) };
      }
    }
  }
}

const NODE_UPSERT = `UNWIND $rows AS row MERGE (n {id: row.id})
SET n:CodeNode, n.key = row.key, n.kind = row.kind, n.name = row.name,
    n.path = row.path, n.hasPath = row.hasPath,
    n.startLine = row.startLine, n.endLine = row.endLine, n.hasRange = row.hasRange,
    n.signature = row.signature, n.hasSignature = row.hasSignature, n.fileHash = row.fileHash,
    n.doc = row.doc, n.hasDoc = row.hasDoc, n.metaJson = row.metaJson, n.hasMeta = row.hasMeta,
    n.tokens = row.tokens, n.sigTokens = row.sigTokens`;

function nodeRow(node: GraphNode): Record<string, unknown> {
  return {
    id: vid(node.id), key: node.id, kind: node.kind, name: node.name,
    path: node.path ?? '', hasPath: node.path !== null,
    startLine: node.range?.startLine ?? 0, endLine: node.range?.endLine ?? 0, hasRange: node.range !== undefined,
    signature: node.signature ?? '', hasSignature: node.signature !== undefined,
    doc: node.doc ?? '', hasDoc: node.doc !== undefined,
    metaJson: node.meta === undefined ? '' : JSON.stringify(node.meta), hasMeta: node.meta !== undefined,
    fileHash: node.fileHash, tokens: node.tokens, sigTokens: node.sigTokens,
  };
}

function decodeRow(columns: string[], row: HydraCell[]): Record<string, unknown> {
  if (columns.length !== row.length) throw new HydraQueryError(`HydraDB row has ${row.length} cells for ${columns.length} columns`);
  return Object.fromEntries(row.map((cell, index) => [columns[index]!, decodeCell(cell)]));
}

export function decodeCell(cell: HydraCell): unknown {
  if (!cell || typeof cell !== 'object' || typeof cell.type !== 'string') {
    throw new HydraQueryError('HydraDB returned a malformed typed cell');
  }
  if (cell.type === 'null') return null;
  if (!('value' in cell)) throw new HydraQueryError('HydraDB returned a typed cell without a value');
  return cell.value;
}

function parseEdgeKey(key: string): { from: string; kind: EdgeKind; to: string } {
  for (const kind of EDGE_KINDS) {
    const separator = `|${kind}|`;
    const at = key.indexOf(separator);
    if (at >= 0) return { from: key.slice(0, at), kind, to: key.slice(at + separator.length) };
  }
  throw new Error(`invalid edge key: ${key}`);
}

function assertEdgeKinds(kinds: EdgeKind[]): void {
  for (const kind of kinds) relationshipType(kind);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new HydraQueryError(`HydraDB returned non-string ${field}`);
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HydraQueryError(`HydraDB returned non-number ${field}`);
  return value;
}

function optionalNumber(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : requiredNumber(value, field);
}

function decodeNode(row: Record<string, unknown>): GraphNode {
  const hasPath = row.hasPath === true;
  const hasRange = row.hasRange === true;
  const hasSignature = row.hasSignature === true;
  const hasDoc = row.hasDoc === true;
  const hasMeta = row.hasMeta === true;
  return {
    id: requiredString(row.id, 'id'),
    kind: requiredString(row.kind, 'kind') as GraphNode['kind'],
    path: hasPath ? requiredString(row.path, 'path') : null,
    name: requiredString(row.name, 'name'),
    ...(hasRange ? { range: { startLine: requiredNumber(row.startLine, 'startLine'), endLine: requiredNumber(row.endLine, 'endLine') } } : {}),
    ...(hasSignature ? { signature: requiredString(row.signature, 'signature') } : {}),
    ...(hasDoc ? { doc: requiredString(row.doc, 'doc') } : {}),
    ...(hasMeta ? { meta: JSON.parse(requiredString(row.metaJson, 'metaJson')) as Record<string, unknown> } : {}),
    fileHash: requiredString(row.fileHash, 'fileHash'),
    tokens: requiredNumber(row.tokens, 'tokens'),
    sigTokens: requiredNumber(row.sigTokens, 'sigTokens'),
  };
}

type RawPath = {
  vertices?: unknown[];
  nodes?: unknown[];
  relationships?: unknown[];
  edges?: unknown[];
};

/** HydraDB v0.4 path payloads contain vertex/relationship records; accept both field names used by its JSON and Bolt codecs. */
function decodeImpactPath(value: unknown, targetId: string): { path: string[]; kinds: EdgeKind[] } {
  if (!value || typeof value !== 'object') throw new HydraQueryError('HydraDB returned a malformed path');
  const raw = value as RawPath;
  const vertices = raw.vertices ?? raw.nodes;
  const relationships = raw.relationships ?? raw.edges;
  if (!Array.isArray(vertices) || !Array.isArray(relationships)) throw new HydraQueryError('HydraDB path omitted vertices or relationships');
  const path = vertices.map(pathNodeKey);
  const kinds = relationships.map(pathRelationshipKind);
  if (path.at(-1) !== targetId && path[0] === targetId) {
    path.reverse();
    kinds.reverse();
  }
  if (path.length !== kinds.length + 1) throw new HydraQueryError('HydraDB path has inconsistent vertices and relationships');
  return { path, kinds };
}

function decodePathEdges(value: unknown): EdgeRow[] {
  if (!value || typeof value !== 'object') throw new HydraQueryError('HydraDB returned a malformed path');
  const raw = value as RawPath;
  const vertices = raw.vertices ?? raw.nodes;
  const relationships = raw.relationships ?? raw.edges;
  if (!Array.isArray(vertices) || !Array.isArray(relationships)) throw new HydraQueryError('HydraDB path omitted vertices or relationships');
  const keys = new Map<unknown, string>();
  for (const vertex of vertices) {
    if (!vertex || typeof vertex !== 'object') throw new HydraQueryError('HydraDB path contains a malformed vertex');
    const record = vertex as Record<string, unknown>;
    keys.set(record.id, pathNodeKey(vertex));
  }
  return relationships.map((relationship) => {
    if (!relationship || typeof relationship !== 'object') throw new HydraQueryError('HydraDB path contains a malformed relationship');
    const record = relationship as Record<string, unknown>;
    const from = keys.get(record.src);
    const to = keys.get(record.dst);
    if (!from || !to) throw new HydraQueryError('HydraDB path relationship references an unknown vertex');
    const properties = record.properties && typeof record.properties === 'object'
      ? record.properties as Record<string, unknown>
      : {};
    return {
      from,
      to,
      kind: pathRelationshipKind(relationship),
      w: optionalNumber(unwrapPathProperty(properties.w), 'path relationship weight'),
    };
  });
}

function pathNodeKey(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') throw new HydraQueryError('HydraDB path contains a malformed vertex');
  const record = value as Record<string, unknown>;
  const properties = record.properties && typeof record.properties === 'object'
    ? record.properties as Record<string, unknown>
    : record;
  return requiredString(unwrapPathProperty(properties.key), 'path vertex key');
}

function pathRelationshipKind(value: unknown): EdgeKind {
  if (typeof value === 'string') return relationshipKind(value);
  if (!value || typeof value !== 'object') throw new HydraQueryError('HydraDB path contains a malformed relationship');
  const record = value as Record<string, unknown>;
  return relationshipKind(requiredString(record.edge_type ?? record.type ?? record.label ?? record.kind, 'path relationship type'));
}

function unwrapPathProperty(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length === 1 ? entries[0]![1] : value;
}

function relationshipKind(type: string): EdgeKind {
  const kind = type.toLowerCase() as EdgeKind;
  if (!EDGE_KINDS.includes(kind)) throw new HydraQueryError(`HydraDB returned unsupported relationship type: ${type}`);
  return kind;
}

function cypherString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

async function mapConcurrent<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
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
