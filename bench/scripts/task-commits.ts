import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { taskCommitShas, validateTaskDirectory } from '../src/task.js';

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function main(): Promise<void> {
  const result = await validateTaskDirectory(benchDir);
  if (result.errors.length) throw new Error(`Task validation failed:\n${result.errors.join('\n')}`);
  const commits = taskCommitShas(result.tasks);
  const output = resolve(benchDir, 'data', 'task-commits.txt');
  await writeFile(output, `${commits.join('\n')}\n`, 'utf8');
  process.stdout.write(`Wrote ${commits.length} accepted task SHA(s) to ${output}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
