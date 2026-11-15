import { extname } from 'node:path';

import type { PackedContext, PackedItem } from '../../packages/core/src/types.js';
import { hashOf } from '../../packages/core/src/util/hash.js';
import { countTokens } from '../../packages/core/src/util/tokens.js';
import { spawnGit } from '../scripts/fetch-repo.js';
import { mulberry32 } from './metrics.js';
import type { Retriever } from './retriever.js';

export interface BaselineRepo {
  listSourceFiles(): Promise<string[]>;
  readFile(path: string): Promise<string>;
}

export function gitBaselineRepo(repo: string, revision: string): BaselineRepo {
  return {
    async listSourceFiles() {
      const output = await spawnGit(['ls-tree', '-r', '--name-only', revision], repo);
      return output.split(/\r?\n/).filter(isSourceFile).sort();
    },
    readFile(path) {
      return spawnGit(['show', `${revision}:${path}`], repo);
    },
  };
}

export function memoizeBaselineRepo(repo: BaselineRepo): BaselineRepo {
  let files: Promise<string[]> | undefined;
  const bodies = new Map<string, Promise<string>>();
  return {
    listSourceFiles() {
      return files ??= repo.listSourceFiles();
    },
    readFile(path) {
      let body = bodies.get(path);
      if (!body) {
        body = repo.readFile(path);
        bodies.set(path, body);
      }
      return body;
    },
  };
}

export function emptyRetriever(): Retriever {
  return async (task, budget) => makeContext(task.id, 'empty', budget, [], '');
}

export function randomRetriever(repo: BaselineRepo, seed = 42): Retriever {
  let sourceFiles: Promise<string[]> | undefined;
  return async (task, budget) => {
    sourceFiles ??= repo.listSourceFiles();
    const paths = seededShuffle(await sourceFiles, seed ^ stringSeed(task.id));
    const context = await packFiles(task.id, 'random', budget, paths, repo);
    return { ...context, configHash: hashOf({ variant: 'random', seed }) };
  };
}

export function oracleRetriever(repo: BaselineRepo): Retriever {
  return async (task, budget) => packFiles(task.id, 'oracle', budget, task.groundTruth.files, repo);
}

export async function packFiles(
  taskId: string,
  variant: string,
  budget: number,
  paths: readonly string[],
  repo: Pick<BaselineRepo, 'readFile'>,
): Promise<PackedContext> {
  const items: PackedItem[] = [];
  let text = '';
  let tokenUpperBound = 0;
  for (const path of paths) {
    const body = await repo.readFile(path);
    const section = renderFile(path, body);
    const sectionTokens = countTokens(section);
    // Separate token counts form a conservative upper bound: joining sections can merge boundary
    // tokens, but cannot require more tokens than encoding each section independently.
    if (tokenUpperBound + sectionTokens > budget) continue;
    text += section;
    tokenUpperBound += sectionTokens;
    items.push({ nodeId: `file:${path}`, path, name: path.split('/').at(-1) ?? path, mode: 'file', tokens: countTokens(body) });
  }
  return makeContext(taskId, variant, budget, items, text);
}

function makeContext(taskId: string, variant: string, budget: number, items: PackedItem[], text: string): PackedContext {
  return {
    contextId: `ctx-${hashOf({ taskId, variant, budget, paths: items.map((item) => item.path) })}`,
    text,
    tokens: countTokens(text),
    budget,
    items,
    seeds: [],
    variant,
    configHash: hashOf({ variant }),
    pruner: 'none',
    graphVersion: 'benchmark-baseline',
    weightsVersion: null,
    timings: { total: 0 },
    degraded: [],
  };
}

function renderFile(path: string, body: string): string {
  const language = extname(path).slice(1) || 'text';
  return `### ${path}\n\`\`\`${language}\n${body}${body.endsWith('\n') ? '' : '\n'}\`\`\`\n`;
}

function seededShuffle<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  const random = mulberry32(seed);
  for (let index = result.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

function stringSeed(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  return hash >>> 0;
}

function isSourceFile(path: string): boolean {
  return /(^|\/)src\/.+\.(?:vue|ts|tsx|js|mjs)$/i.test(path)
    && !/\.d\.ts$/i.test(path)
    && !/(^|\/)(?:tests?|__tests__|dist|coverage|generated)(\/|$)/i.test(path)
    && !/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path);
}
