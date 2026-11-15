import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildIndex, type BuildResult } from '../../../core/src/indexer/build.js';
import { MemoryStore } from '../../../core/src/store/memory.js';
import { FakeEmbedder, FakeGraphStore } from '../../../core/src/testing/fakes.js';
import { runProbe } from './probe.js';
import { runPull } from './pull.js';
import { runPush } from './push.js';
import { readLastPushedVersion, readSnapshot } from './push-state.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'core', 'test', 'fixtures', 'mini-vue');
let build: BuildResult;
const temporary: string[] = [];

class VersionedFakeGraphStore extends FakeGraphStore {
  version: string | null = null;
  override async upsertGraph(batch: Parameters<FakeGraphStore['upsertGraph']>[0], version: string): Promise<void> {
    await super.upsertGraph(batch, version);
    this.version = version;
  }
  async getIndexVersion(): Promise<string | null> { return this.version; }
}

beforeAll(async () => { build = await buildIndex(FIXTURE, undefined, { cache: false }); });
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'click-push-'));
  temporary.push(path);
  return path;
}

const io = () => {
  const lines = { out: [] as string[], err: [] as string[] };
  return { lines, value: { out: (text: string) => lines.out.push(text), err: (text: string) => lines.err.push(text) } };
};

describe('click push / pull / probe', () => {
  it('pushes a full graph, persists embedded chunks, then makes a zero-topology delta', async () => {
    const repo = await root();
    const graph = new VersionedFakeGraphStore();
    const store = new MemoryStore();
    const embedder = new FakeEmbedder(16);
    const first = io();
    expect(await runPush(['--root', repo], first.value, repo, { build: async () => build, graph, store, embedder })).toBe(0);
    expect(first.lines.out[0]).toContain('(full:');
    expect(graph.nodes.size).toBe(build.graph.nodes.length);
    expect(await readLastPushedVersion(repo)).toBe(build.graph.version);
    const snapshot = await readSnapshot(repo);
    expect(snapshot?.graph.version).toBe(build.graph.version);
    expect(snapshot?.chunks.every((chunk) => chunk.vector?.length === 16)).toBe(true);

    const second = io();
    expect(await runPush(['--root', repo], second.value, repo, { build: async () => build, graph, store, embedder })).toBe(0);
    expect(second.lines.out[0]).toContain('(delta: 0 node changes, 0 edge changes');
  });

  it('pull rebuilds the local graph and verifies the Hydra metadata version', async () => {
    const repo = await root();
    const graph = new VersionedFakeGraphStore();
    await graph.upsertGraph({ nodes: build.graph.nodes, edges: build.graph.edges }, build.graph.version);
    const output = io();
    expect(await runPull(['--root', repo], output.value, repo, { graph, store: new MemoryStore() })).toBe(0);
    expect((await readSnapshot(repo))?.graph).toMatchObject({
      version: build.graph.version,
      nodes: expect.arrayContaining(build.graph.nodes),
      edges: expect.arrayContaining(build.graph.edges),
    });
  });

  it('is local-only unless OpenAI embeddings are explicitly enabled', async () => {
    const repo = await root();
    const output = io();
    expect(await runPush(['--root', repo], output.value, repo, {
      build: async () => build, graph: new VersionedFakeGraphStore(), store: new MemoryStore(),
    })).toBe(0);
    expect(output.lines.out[0]).toContain('local-only');
    expect((await readSnapshot(repo))?.chunks.every((chunk) => chunk.vector === undefined)).toBe(true);
  });

  it('probe performs twenty neighbourhood reads plus impact, hubs, and one query embedding', async () => {
    const repo = await root();
    const graph = new VersionedFakeGraphStore();
    await graph.upsertGraph({ nodes: build.graph.nodes, edges: build.graph.edges }, build.graph.version);
    const embedder = new FakeEmbedder(12);
    const output = io();
    expect(await runProbe(['--root', repo], output.value, repo, { build: async () => build, graph, embedder })).toBe(0);
    const result = JSON.parse(output.lines.out[0]!) as { neighbourhood: { runs: number }; embedding: { dims: number } };
    expect(result.neighbourhood.runs).toBe(20);
    expect(result.embedding.dims).toBe(12);
    expect(graph.calls).toBe(22);
    expect(embedder.calls).toBe(1);
  });

  it('reports argument errors without doing work', async () => {
    const output = io();
    expect(await runPush(['--wat'], output.value, process.cwd())).toBe(2);
    expect(output.lines.err[0]).toContain('usage: click push');
  });
});
