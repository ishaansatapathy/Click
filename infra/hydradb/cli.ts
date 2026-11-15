import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

export type HydraCommand = 'up' | 'down' | 'reset' | 'logs';

const infraDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(infraDir, '..', '..');
const composeFile = resolve(infraDir, 'docker-compose.yml');
const defaultTokenFile = resolve(repoRoot, '.click', 'hydradb-token');
const defaultReadyUrl = 'http://127.0.0.1:9090/readyz';

export interface HydraCliDeps {
  runDocker?: (args: string[], env: NodeJS.ProcessEnv) => Promise<void>;
  waitUntilReady?: (url: string, timeoutMs: number) => Promise<void>;
  tokenFile?: string;
}

export function composeArgs(...args: string[]): string[] {
  return ['compose', '--project-directory', infraDir, '--file', composeFile, ...args];
}

export async function ensureToken(path: string): Promise<string> {
  try {
    const token = (await readFile(path, 'utf8')).trim();
    if (token) return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('hex');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return token;
}

export async function runHydraCommand(command: HydraCommand, deps: HydraCliDeps = {}): Promise<void> {
  const runDocker = deps.runDocker ?? spawnDocker;
  const waitUntilReady = deps.waitUntilReady ?? pollReady;
  const configuredTokenPath = deps.tokenFile ?? process.env.HYDRADB_TOKEN_FILE ?? defaultTokenFile;
  const tokenPath = isAbsolute(configuredTokenPath) ? configuredTokenPath : resolve(repoRoot, configuredTokenPath);
  let token = await ensureToken(tokenPath);
  const env = (): NodeJS.ProcessEnv => ({
    ...process.env,
    HYDRADB_TOKEN: token,
    HYDRADB_TOKEN_FILE: tokenPath,
    MSYS_NO_PATHCONV: '1',
  });

  if (command === 'up') {
    await runDocker(composeArgs('up', '--detach', '--remove-orphans'), env());
    await waitUntilReady(process.env.HYDRADB_READY_URL ?? defaultReadyUrl, 30_000);
    process.stdout.write(`HydraDB ready; token file: ${tokenPath}\n`);
    return;
  }
  if (command === 'down') {
    await runDocker(composeArgs('down', '--remove-orphans'), env());
    return;
  }
  if (command === 'logs') {
    await runDocker(composeArgs('logs', '--follow', 'graph-node', 'graph-indexer'), env());
    return;
  }

  await runDocker(composeArgs('down', '--volumes', '--remove-orphans'), env());
  await rm(tokenPath, { force: true });
  token = await ensureToken(tokenPath);
  await runDocker(composeArgs('up', '--detach', '--remove-orphans'), env());
  await waitUntilReady(process.env.HYDRADB_READY_URL ?? defaultReadyUrl, 30_000);
  process.stdout.write(`HydraDB reset and ready; token file: ${tokenPath}\n`);
}

export async function pollReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let detail = 'not ready';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      detail = `HTTP ${response.status}`;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`HydraDB did not become ready at ${url} within ${timeoutMs} ms (${detail})`);
}

async function spawnDocker(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('docker', args, { cwd: repoRoot, env, shell: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`docker ${args.join(' ')} exited with ${code ?? `signal ${signal}`}`));
    });
  });
}

function loadLocalEnv(): void {
  for (const path of [resolve(repoRoot, '.env'), resolve(infraDir, '.env')]) {
    if (existsSync(path)) process.loadEnvFile(path);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  loadLocalEnv();
  const command = process.argv[2];
  if (command !== 'up' && command !== 'down' && command !== 'reset' && command !== 'logs') {
    process.stderr.write('Usage: hydra <up|down|reset|logs>\n');
    process.exitCode = 2;
  } else {
    void runHydraCommand(command).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
