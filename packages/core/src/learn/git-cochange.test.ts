import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIndex } from '../indexer/build.js';
import { updateIndex } from '../indexer/incremental.js';
import { loadExcludedShas, mineCoChange } from './git-cochange.js';

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'click-cochange-'));
});
afterEach(() => rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let n = 0;
/** Commit changes to the given files (each gets a new line) and return the new SHA. */
function commit(files: string[], message = `c${++n}`): string {
  for (const f of files) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), `${(() => { try { return readFileSync(join(repo, f), 'utf8'); } catch { return ''; } })()}// ${message}\n`);
  }
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD').trim();
}
const keys = (r: Awaited<ReturnType<typeof mineCoChange>>): string[] => r.edges.map((e) => e.key);

describe('mineCoChange (PROMPTS 157)', () => {
  beforeEach(() => {
    git('init', '-q');
    n = 0;
  });

  it('keeps pairs with support >= 2 and Jaccard >= 0.3 as undirected co_changed edges with meta.source git', async () => {
    commit(['a.ts', 'b.ts']);
    commit(['a.ts', 'b.ts']);
    commit(['a.ts', 'b.ts', 'c.ts']);
    commit(['a.ts', 'd.ts']); // a+d: support 1; a+c: support 1
    const r = await mineCoChange(repo);
    expect(keys(r)).toEqual(['file:a.ts|co_changed|file:b.ts']);
    expect(r.edges[0]).toEqual({ key: 'file:a.ts|co_changed|file:b.ts', from: 'file:a.ts', to: 'file:b.ts', kind: 'co_changed', meta: { source: 'git', support: 3 } });
    expect(r.stats).toMatchObject({ commits: 4, used: 4, excluded: 0, kept: 1 });
  });

  it('Jaccard filters out a busy file that merely often appears next to another', async () => {
    for (let i = 0; i < 8; i++) commit(['busy.ts', `other${i}.ts`]);
    commit(['busy.ts', 'rare.ts']);
    commit(['busy.ts', 'rare.ts']); // support 2, but busy changed in 10 commits and rare in 2: 2 / (10 + 2 - 2) = 0.2
    expect(keys(await mineCoChange(repo))).toEqual([]);
    expect(keys(await mineCoChange(repo, { minJaccard: 0.2 }))).toEqual(['file:busy.ts|co_changed|file:rare.ts']);
    expect(keys(await mineCoChange(repo, { minSupport: 3, minJaccard: 0 }))).toEqual([]);
  });

  it('EXCLUDED COMMITS CONTRIBUTE NOTHING: removing the evidence removes the edge, by SHA', async () => {
    const c1 = commit(['a.ts', 'b.ts']);
    const c2 = commit(['a.ts', 'b.ts']);
    const c3 = commit(['a.ts', 'b.ts']);
    expect(keys(await mineCoChange(repo))).toHaveLength(1);
    const one = await mineCoChange(repo, { exclude: new Set([c1]) });
    expect(one.edges[0]!.meta?.support).toBe(2); // still strong enough, but counted from two commits
    expect(one.stats.excluded).toBe(1);
    const two = await mineCoChange(repo, { exclude: new Set([c1, c2]) });
    expect(two.edges).toEqual([]); // one shared commit left: below support 2
    const all = await mineCoChange(repo, { exclude: new Set([c1, c2, c3]) });
    expect(all).toMatchObject({ edges: [], stats: { used: 0, excluded: 3 } });
    // an exclusion that names no real commit changes nothing
    expect(keys(await mineCoChange(repo, { exclude: new Set(['0'.repeat(40)]) }))).toHaveLength(1);
  });

  it('only history before H: later commits do not count', async () => {
    commit(['a.ts', 'b.ts']);
    const h = commit(['a.ts', 'b.ts']);
    commit(['a.ts', 'b.ts']);
    const before = await mineCoChange(repo, { before: h });
    expect(before.edges[0]!.meta?.support).toBe(2);
    expect((await mineCoChange(repo)).edges[0]!.meta?.support).toBe(3);
    expect((await mineCoChange(repo, { before: `${h}~1` })).edges).toEqual([]); // only one commit before
  });

  it('sweeping commits and merge commits say nothing about what belongs together', async () => {
    commit(['a.ts', 'b.ts']);
    commit(['a.ts', 'b.ts']);
    commit(Array.from({ length: 40 }, (_, i) => `bulk/f${i}.ts`).concat(['a.ts', 'b.ts'])); // a formatting sweep
    const r = await mineCoChange(repo);
    expect(r.stats.skippedLarge).toBe(1);
    expect(r.edges[0]!.meta?.support).toBe(2);
    expect(keys(await mineCoChange(repo, { maxFilesPerCommit: 100 }))).toContain('file:a.ts|co_changed|file:b.ts');

    git('checkout', '-q', '-b', 'side');
    commit(['s1.ts', 's2.ts']);
    git('checkout', '-q', '-');
    commit(['m1.ts']);
    git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    const merged = await mineCoChange(repo);
    expect(keys(merged).some((k) => k.includes('s1.ts') && k.includes('s2.ts'))).toBe(false); // support 1 only
  });

  it('only indexed files take part, renames follow the new name, deleted files do not appear', async () => {
    commit(['a.ts', 'b.ts', 'ignored.log']);
    commit(['a.ts', 'b.ts', 'ignored.log']);
    const filtered = await mineCoChange(repo, { files: new Set(['a.ts', 'b.ts']) });
    expect(keys(filtered)).toEqual(['file:a.ts|co_changed|file:b.ts']);
    expect(keys(await mineCoChange(repo))).toEqual(expect.arrayContaining(['file:a.ts|co_changed|file:ignored.log', 'file:b.ts|co_changed|file:ignored.log']));
  });

  it('not a git repository, or an unknown revision: no edges, no throw', async () => {
    expect((await mineCoChange(repo, { before: 'no-such-revision' })).edges).toEqual([]);
    const bare = mkdtempSync(join(tmpdir(), 'click-nogit-'));
    try {
      expect(await mineCoChange(bare)).toMatchObject({ edges: [], stats: { commits: 0 } });
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('is deterministic: the same history gives the same edges in the same order', async () => {
    for (let i = 0; i < 3; i++) commit(['z.ts', 'a.ts', 'm.ts']);
    const a = await mineCoChange(repo);
    expect(JSON.stringify(await mineCoChange(repo))).toBe(JSON.stringify(a));
    expect(keys(a)).toEqual(['file:a.ts|co_changed|file:m.ts', 'file:a.ts|co_changed|file:z.ts', 'file:m.ts|co_changed|file:z.ts']);
  });
});

describe('loadExcludedShas', () => {
  it('reads 40-hex SHAs, ignores comments, blanks and junk, lower-cases', async () => {
    const f = join(repo, 'task-commits.txt');
    writeFileSync(f, `# the benchmark's task commits\n${'A'.repeat(40)}\n\n${'b'.repeat(40)} # trailing note\nnot-a-sha\n${'c'.repeat(39)}\n`);
    expect([...(await loadExcludedShas(f))].sort()).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
  });
});

describe('buildIndex with coChange (the learn.gitCoChange flag)', () => {
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');

  async function fixtureRepo(): Promise<void> {
    cpSync(FIXTURE, repo, { recursive: true, filter: (s) => !/[\\/]\.click([\\/]|$)/.test(s) });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'initial');
    for (let i = 0; i < 3; i++) commit(['src/stores/order.ts', 'src/components/CheckoutButton.vue'], `feature ${i}`);
  }
  const cache = (): string => mkdtempSync(join(tmpdir(), 'click-cc-cache-'));

  it('off by default; on, the graph gains git co_changed edges between indexed files and a new version', async () => {
    await fixtureRepo();
    const off = await buildIndex(repo, undefined, { cacheDir: cache(), now: () => new Date(0) });
    expect(off.graph.edges.filter((e) => e.kind === 'co_changed')).toEqual([]);
    const on = await buildIndex(repo, undefined, { cacheDir: cache(), now: () => new Date(0), coChange: {} });
    const edges = on.graph.edges.filter((e) => e.kind === 'co_changed');
    const pair = edges.find((e) => e.key === 'file:src/components/CheckoutButton.vue|co_changed|file:src/stores/order.ts');
    expect(pair?.meta).toMatchObject({ source: 'git', support: 4 }); // the initial commit plus the three feature commits
    expect(on.graph.version).not.toBe(off.graph.version);
    const ids = new Set(on.graph.nodes.map((x) => x.id));
    for (const e of edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    expect(on.state.coChange).toEqual({});
  }, 60_000);

  it('the benchmark\'s way: excluding the shared commits removes the edge from the graph', async () => {
    await fixtureRepo();
    const shas = git('log', '--format=%H', '-n3').trim().split('\n');
    const on = await buildIndex(repo, undefined, { cacheDir: cache(), now: () => new Date(0), coChange: { exclude: new Set(shas) } });
    expect(on.graph.edges.some((e) => e.kind === 'co_changed' && e.key.includes('order.ts') && e.key.includes('CheckoutButton'))).toBe(false);
  }, 60_000);

  it('incremental updates keep the git edges (they describe history, not the working tree), and a full rebuild repeats the option', async () => {
    await fixtureRepo();
    const first = await buildIndex(repo, undefined, { cacheDir: cache(), now: () => new Date(0), coChange: {} });
    writeFileSync(join(repo, 'src', 'composables', 'useFormat.ts'), `${readFileSync(join(repo, 'src', 'composables', 'useFormat.ts'), 'utf8')}\nexport const extra = 1;\n`);
    const upd = await updateIndex(first.state, [{ path: 'src/composables/useFormat.ts', status: 'M' }], { cacheDir: cache() });
    expect(upd.state.graph.edges.filter((e) => e.kind === 'co_changed').map((e) => e.key)).toEqual(first.graph.edges.filter((e) => e.kind === 'co_changed').map((e) => e.key));
    expect(upd.state.extraEdges).toEqual(first.state.extraEdges);

    const profileTouch = await updateIndex(upd.state, [{ path: 'package.json', status: 'M' }], { cacheDir: cache() }); // forces a full rebuild
    expect(profileTouch.stats.fullRebuild).toBe(true);
    expect(profileTouch.state.graph.edges.some((e) => e.kind === 'co_changed')).toBe(true);
  }, 90_000);

  it('a co-change pair whose file was deleted drops out on the next update', async () => {
    await fixtureRepo();
    const first = await buildIndex(repo, undefined, { cacheDir: cache(), now: () => new Date(0), coChange: {} });
    rmSync(join(repo, 'src', 'components', 'CheckoutButton.vue'));
    const upd = await updateIndex(first.state, [{ path: 'src/components/CheckoutButton.vue', status: 'D' }], { cacheDir: cache() });
    expect(upd.state.graph.edges.some((e) => e.kind === 'co_changed' && e.key.includes('CheckoutButton'))).toBe(false);
  }, 90_000);
});
