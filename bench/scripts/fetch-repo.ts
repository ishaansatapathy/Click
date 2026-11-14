import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface BenchConfig {
  repoUrl: string;
  pinnedSha: string;
}

export type GitRunner = (args: readonly string[], cwd?: string) => Promise<string>;

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const defaultBenchDir = resolve(scriptsDir, '..');

export function loadBenchConfig(path = resolve(defaultBenchDir, 'bench.config.json')): BenchConfig {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(value) || typeof value.repoUrl !== 'string' || !value.repoUrl) {
    throw new Error(`Invalid benchmark config at ${path}: repoUrl must be a non-empty string`);
  }
  if (typeof value.pinnedSha !== 'string' || !/^[a-f0-9]{40}$/i.test(value.pinnedSha)) {
    throw new Error(`Invalid benchmark config at ${path}: pinnedSha must be a full Git SHA`);
  }
  return { repoUrl: value.repoUrl, pinnedSha: value.pinnedSha.toLowerCase() };
}

export async function ensureBenchmarkRepo(
  config: BenchConfig,
  target = resolve(defaultBenchDir, 'repo'),
  runGit: GitRunner = spawnGit,
): Promise<string> {
  const gitDir = resolve(target, '.git');
  if (!existsSync(target)) {
    await runGit(['clone', '--origin', 'origin', config.repoUrl, target]);
  } else if (!existsSync(gitDir)) {
    throw new Error(`Benchmark target exists but is not a Git repository: ${target}`);
  } else {
    const actualRemote = (await runGit(['remote', 'get-url', 'origin'], target)).trim();
    if (normaliseRemote(actualRemote) !== normaliseRemote(config.repoUrl)) {
      throw new Error(`Benchmark target has unexpected origin: ${actualRemote}`);
    }
  }

  await runGit(['fetch', '--all', '--tags', '--prune'], target);
  await runGit(['checkout', '--detach', config.pinnedSha], target);
  const actualSha = (await runGit(['rev-parse', 'HEAD'], target)).trim().toLowerCase();
  if (actualSha !== config.pinnedSha.toLowerCase()) {
    throw new Error(`Expected benchmark HEAD ${config.pinnedSha}, got ${actualSha}`);
  }
  return actualSha;
}

export function spawnGit(args: readonly string[], cwd?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', [...args], { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`git ${args.join(' ')} failed (${code ?? 'signal'}): ${stderr.trim()}`));
    });
  });
}

function normaliseRemote(remote: string): string {
  return remote.trim().replace(/\\/g, '/').replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  void main();
}

async function main(): Promise<void> {
  const config = loadBenchConfig();
  const sha = await ensureBenchmarkRepo(config);
  process.stdout.write(`Benchmark repository ready at ${sha}\n`);
}
