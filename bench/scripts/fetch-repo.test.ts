import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureBenchmarkRepo, loadBenchConfig, spawnGit } from './fetch-repo.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('loadBenchConfig', () => {
  it('loads a repository URL and full pinned SHA', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'bench.config.json');
    await writeFile(path, JSON.stringify({ repoUrl: 'https://example.test/repo.git', pinnedSha: 'A'.repeat(40) }));
    expect(loadBenchConfig(path)).toEqual({
      repoUrl: 'https://example.test/repo.git',
      pinnedSha: 'a'.repeat(40),
    });
  });

  it('rejects abbreviated SHAs', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'bench.config.json');
    await writeFile(path, JSON.stringify({ repoUrl: 'https://example.test/repo.git', pinnedSha: 'abc1234' }));
    expect(() => loadBenchConfig(path)).toThrow(/full Git SHA/);
  });
});

describe('ensureBenchmarkRepo', () => {
  it('clones, pins, and remains idempotent without using a shell', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'source');
    const target = join(root, 'target');
    await mkdir(source);
    await spawnGit(['init', '--initial-branch=main'], source);
    await spawnGit(['config', 'user.name', 'Click Test'], source);
    await spawnGit(['config', 'user.email', 'click@example.test'], source);
    await writeFile(join(source, 'fixture.txt'), 'fixture\n');
    await spawnGit(['add', 'fixture.txt'], source);
    await spawnGit(['commit', '-m', 'fixture'], source);
    const pinnedSha = (await spawnGit(['rev-parse', 'HEAD'], source)).trim();
    const config = { repoUrl: source, pinnedSha };

    await expect(ensureBenchmarkRepo(config, target)).resolves.toBe(pinnedSha);
    await expect(ensureBenchmarkRepo(config, target)).resolves.toBe(pinnedSha);
    expect((await spawnGit(['rev-parse', '--abbrev-ref', 'HEAD'], target)).trim()).toBe('HEAD');
  });

  it('refuses to overwrite a non-repository directory', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'target');
    await mkdir(target);
    await expect(ensureBenchmarkRepo({ repoUrl: root, pinnedSha: 'a'.repeat(40) }, target))
      .rejects.toThrow(/not a Git repository/);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'click-fetch-repo-'));
  temporaryPaths.push(path);
  return path;
}
