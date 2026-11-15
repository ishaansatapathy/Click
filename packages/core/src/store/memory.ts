import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ChunkRecord, Convention, GraphEdge, GraphNode, WeightsDoc } from '../types.js';
import type { HybridQuery, RemoveIds, ScoredId, Store, UpsertBatch } from './types.js';

export interface MemoryStoreOptions {
  persistencePath?: string;
  pageSize?: number;
  rrfK?: number;
}

interface MemorySnapshot {
  v: 1;
  indexVersion: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  chunks: ChunkRecord[];
  weights: WeightsDoc | null;
  conventions: Convention[];
}

interface SearchDocument {
  id: string;
  text: string;
  vector?: number[];
}

const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

export class MemoryStore implements Store {
  readonly name = 'memory';
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();
  private readonly chunks = new Map<string, ChunkRecord>();
  private readonly persistencePath: string | undefined;
  private readonly pageSize: number;
  private readonly rrfK: number;
  private indexVersion: string | null = null;
  private weights: WeightsDoc | null = null;
  private conventions: Convention[] = [];
  private loaded: Promise<void> | undefined;
  private mutations: Promise<void> = Promise.resolve();

  constructor(options: MemoryStoreOptions | string = {}) {
    const resolved = typeof options === 'string' ? { persistencePath: options } : options;
    this.persistencePath = resolved.persistencePath;
    this.pageSize = resolved.pageSize ?? 100;
    this.rrfK = resolved.rrfK ?? 60;
    if (!Number.isInteger(this.pageSize) || this.pageSize <= 0) throw new Error('MemoryStore pageSize must be a positive integer');
    if (!Number.isFinite(this.rrfK) || this.rrfK <= 0) throw new Error('MemoryStore rrfK must be positive');
  }

  async upsert(batch: UpsertBatch, indexVersion: string): Promise<void> {
    await this.mutate(async () => {
      for (const item of batch.nodes ?? []) this.nodes.set(item.id, structuredClone(item));
      for (const item of batch.edges ?? []) this.edges.set(item.key, structuredClone(item));
      for (const item of batch.chunks ?? []) this.chunks.set(item.id, structuredClone(item));
      this.indexVersion = indexVersion;
    });
  }

  async remove(ids: RemoveIds): Promise<void> {
    await this.mutate(async () => {
      for (const id of ids.nodeIds ?? []) this.nodes.delete(id);
      for (const key of ids.edgeKeys ?? []) this.edges.delete(key);
      for (const id of ids.chunkIds ?? []) this.chunks.delete(id);
    });
  }

  async hybridQuery(q: HybridQuery, signal?: AbortSignal): Promise<ScoredId[]> {
    await this.ready();
    throwIfAborted(signal);
    if (q.k <= 0) return [];

    const documents: SearchDocument[] = q.kinds
      ? [...this.nodes.values()]
          .filter((node) => q.kinds!.includes(node.kind))
          .map((node) => ({
            id: node.id,
            text: [node.name, node.path ?? '', node.signature ?? '', node.doc ?? ''].join(' '),
          }))
      : [...this.chunks.values()].map((item) => ({ id: item.id, text: item.text, vector: item.vector }));

    const lexical = bm25(documents, q.text);
    const semantic = q.vector ? vectorRanking(documents, q.vector) : [];
    const scores = new Map<string, number>();
    for (const ranking of [lexical, semantic]) {
      ranking.forEach(({ id }, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (this.rrfK + index + 1)));
    }
    throwIfAborted(signal);
    return [...scores]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, q.k);
  }

  async *loadAll(): AsyncIterable<UpsertBatch> {
    await this.ready();
    const nodes = [...this.nodes.values()].sort(byId).map((item) => structuredClone(item));
    const edges = [...this.edges.values()].sort((a, b) => a.key.localeCompare(b.key)).map((item) => structuredClone(item));
    const chunks = [...this.chunks.values()].sort(byId).map((item) => structuredClone(item));
    const pages = Math.ceil(Math.max(nodes.length, edges.length, chunks.length) / this.pageSize);
    for (let page = 0; page < pages; page++) {
      const start = page * this.pageSize;
      const result: UpsertBatch = {};
      if (start < nodes.length) result.nodes = nodes.slice(start, start + this.pageSize);
      if (start < edges.length) result.edges = edges.slice(start, start + this.pageSize);
      if (start < chunks.length) result.chunks = chunks.slice(start, start + this.pageSize);
      yield result;
    }
  }

  async getWeights(): Promise<WeightsDoc | null> {
    await this.ready();
    return this.weights ? structuredClone(this.weights) : null;
  }

  async putWeights(doc: WeightsDoc): Promise<void> {
    await this.mutate(async () => { this.weights = structuredClone(doc); });
  }

  async getConventions(): Promise<Convention[]> {
    await this.ready();
    return structuredClone(this.conventions);
  }

  async putConventions(items: Convention[]): Promise<void> {
    await this.mutate(async () => { this.conventions = structuredClone(items); });
  }

  private async ready(): Promise<void> {
    await this.mutations;
    await this.ensureLoaded();
  }

  private ensureLoaded(): Promise<void> {
    return this.loaded ??= this.load();
  }

  private async mutate(change: () => Promise<void>): Promise<void> {
    const operation = this.mutations.then(async () => {
      await this.ensureLoaded();
      await change();
      await this.persist();
    });
    this.mutations = operation.catch(() => undefined);
    await operation;
  }

  private async load(): Promise<void> {
    if (!this.persistencePath) return;
    let raw: string;
    try {
      raw = await readFile(this.persistencePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const snapshot = JSON.parse(raw) as unknown;
    if (!isSnapshot(snapshot)) throw new Error(`invalid MemoryStore snapshot: ${this.persistencePath}`);
    for (const item of snapshot.nodes) this.nodes.set(item.id, structuredClone(item));
    for (const item of snapshot.edges) this.edges.set(item.key, structuredClone(item));
    for (const item of snapshot.chunks) this.chunks.set(item.id, structuredClone(item));
    this.indexVersion = snapshot.indexVersion;
    this.weights = snapshot.weights ? structuredClone(snapshot.weights) : null;
    this.conventions = structuredClone(snapshot.conventions);
  }

  private async persist(): Promise<void> {
    if (!this.persistencePath) return;
    const snapshot: MemorySnapshot = {
      v: 1,
      indexVersion: this.indexVersion,
      nodes: [...this.nodes.values()].sort(byId),
      edges: [...this.edges.values()].sort((a, b) => a.key.localeCompare(b.key)),
      chunks: [...this.chunks.values()].sort(byId),
      weights: this.weights,
      conventions: this.conventions,
    };
    await mkdir(dirname(this.persistencePath), { recursive: true });
    const temporary = `${this.persistencePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(snapshot), 'utf8');
      await renameWithRetry(temporary, this.persistencePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

function searchTokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1)
    .map((token) => token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token);
}

function bm25(documents: SearchDocument[], query: string): ScoredId[] {
  const queryTerms = [...new Set(searchTokens(query))];
  if (!documents.length || !queryTerms.length) return [];
  const tokenized = documents.map((document) => searchTokens(document.text));
  const averageLength = tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / tokenized.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const tokens of tokenized) {
    for (const term of new Set(tokens)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const k1 = 1.2;
  const b = 0.75;
  return documents
    .map((document, index) => {
      const tokens = tokenized[index]!;
      const frequencies = new Map<string, number>();
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      let score = 0;
      for (const term of queryTerms) {
        const frequency = frequencies.get(term) ?? 0;
        if (!frequency) continue;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        score += idf * frequency * (k1 + 1) / (frequency + k1 * (1 - b + b * tokens.length / averageLength));
      }
      return { id: document.id, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function vectorRanking(documents: SearchDocument[], query: number[]): ScoredId[] {
  return documents
    .map((document) => ({ id: document.id, score: document.vector ? cosine(query, document.vector) : 0 }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index]! * b[index]!;
    normA += a[index]! ** 2;
    normB += b[index]! ** 2;
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

function isSnapshot(value: unknown): value is MemorySnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MemorySnapshot>;
  return candidate.v === 1
    && (candidate.indexVersion === null || typeof candidate.indexVersion === 'string')
    && Array.isArray(candidate.nodes)
    && Array.isArray(candidate.edges)
    && Array.isArray(candidate.chunks)
    && (candidate.weights === null || typeof candidate.weights === 'object')
    && Array.isArray(candidate.conventions);
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 5 || !RETRYABLE_RENAME.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
    }
  }
}
