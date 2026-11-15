import { gzip, gunzip } from 'node:zlib';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ChunkRecord, Graph } from '../../../core/src/types.js';
import { clickDir } from '../../../core/src/util/paths.js';

const zip = promisify(gzip);
const unzip = promisify(gunzip);

export interface PushSnapshot {
  v: 1;
  graph: Graph;
  chunks: ChunkRecord[];
}

export interface PushPaths {
  dir: string;
  graphDir: string;
  current: string;
  lastPushedVersion: string;
  memstore: string;
  cacheDir: string;
}

export function pushPaths(root: string): PushPaths {
  const dir = clickDir(root);
  return {
    dir,
    graphDir: join(dir, 'graph'),
    current: join(dir, 'graph', 'CURRENT'),
    lastPushedVersion: join(dir, 'lastPushedVersion'),
    memstore: join(dir, 'memstore.json'),
    cacheDir: join(dir, 'cache'),
  };
}

export async function writeSnapshot(root: string, snapshot: PushSnapshot): Promise<void> {
  const paths = pushPaths(root);
  await mkdir(paths.graphDir, { recursive: true });
  const target = join(paths.graphDir, `${snapshot.graph.version}.json.gz`);
  await atomicWrite(target, await zip(JSON.stringify(snapshot)));
  await atomicWrite(paths.current, snapshot.graph.version);
}

export async function readSnapshot(root: string, version?: string): Promise<PushSnapshot | null> {
  const paths = pushPaths(root);
  try {
    const selected = version ?? (await readFile(paths.current, 'utf8')).trim();
    if (!selected) return null;
    const parsed = JSON.parse((await unzip(await readFile(join(paths.graphDir, `${selected}.json.gz`)))).toString('utf8')) as unknown;
    if (!isSnapshot(parsed)) throw new Error(`invalid graph snapshot ${selected}`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readLastPushedVersion(root: string): Promise<string | null> {
  try {
    const value = (await readFile(pushPaths(root).lastPushedVersion, 'utf8')).trim();
    return value || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeLastPushedVersion(root: string, version: string): Promise<void> {
  await mkdir(pushPaths(root).dir, { recursive: true });
  await atomicWrite(pushPaths(root).lastPushedVersion, version);
}

async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

function isSnapshot(value: unknown): value is PushSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<PushSnapshot>;
  return snapshot.v === 1 && !!snapshot.graph && typeof snapshot.graph.version === 'string' && Array.isArray(snapshot.chunks);
}
