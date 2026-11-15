import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildIndex } from '../../packages/core/src/indexer/build.js';
import { loadBenchConfig, spawnGit } from '../scripts/fetch-repo.js';
import { loadRejected, loadTaskValues, validateTasks, type BenchTask } from './task.js';

export function sampleTasks(tasks: readonly BenchTask[], count: number, random: () => number = Math.random): BenchTask[] {
  if (!Number.isInteger(count) || count < 1) throw new Error('--n must be a positive integer');
  const values = [...tasks];
  for (let index = values.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [values[index], values[target]] = [values[target]!, values[index]!];
  }
  return values.slice(0, count);
}

export async function renderReview(
  tasks: readonly BenchTask[],
  commitMessage: (sha: string) => Promise<string>,
): Promise<string> {
  const sections: string[] = [];
  for (const task of tasks) {
    const message = task.commit ? (await commitMessage(task.commit)).trim() : '(hand-authored task)';
    sections.push([
      `## ${task.id}`,
      `Type: ${task.type} | Split: ${task.split} | E2E: ${task.e2e}`,
      `Text: ${task.text}`,
      `Ground truth files: ${task.groundTruth.files.join(', ')}`,
      `Ground truth symbols: ${task.groundTruth.symbols.join(', ') || '(none)'}`,
      'Commit message:',
      message,
    ].join('\n'));
  }
  return `${sections.join('\n\n')}\n\nReject a task by adding its ID to bench/tasks/rejected.txt.\n`;
}

function parseCount(args: readonly string[]): number {
  if (args.length !== 2 || args[0] !== '--n') throw new Error('Usage: pnpm bench:review --n 20');
  const count = Number(args[1]);
  if (!Number.isInteger(count) || count < 1) throw new Error('--n must be a positive integer');
  return count;
}

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const count = parseCount(process.argv.slice(2));
  const config = loadBenchConfig(resolve(benchDir, 'bench.config.json'));
  const repo = resolve(benchDir, 'repo');
  const files = new Set((await spawnGit(['ls-tree', '-r', '--name-only', config.pinnedSha], repo)).split(/\r?\n/).filter(Boolean));
  const nodeIds = new Set((await buildIndex(repo)).graph.nodes.map((node) => node.id));
  const validation = validateTasks(
    await loadTaskValues(resolve(benchDir, 'tasks')),
    files,
    nodeIds,
    await loadRejected(resolve(benchDir, 'tasks', 'rejected.txt')),
  );
  if (validation.errors.length) throw new Error(`Task validation failed:\n${validation.errors.join('\n')}`);
  if (!validation.tasks.length) throw new Error('No accepted benchmark tasks are available for review');
  const selected = sampleTasks(validation.tasks, count);
  process.stdout.write(await renderReview(selected, (sha) => spawnGit(['show', '-s', '--format=%B', sha], repo)));
}
