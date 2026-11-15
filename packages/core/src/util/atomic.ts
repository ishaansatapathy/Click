// Atomic file replacement: write a temp file in the same directory, then rename it over the target.
// Readers see either the old complete file or the new complete file, never a partial one, and a crash leaves at
// worst an orphan `*.tmp` that readers ignore. Shared by the disk cache, snapshots and weights.

import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']); // Windows can hold a file briefly (antivirus, indexer)

export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 5 || !RETRYABLE_RENAME.has(code)) throw e;
      await new Promise((r) => setTimeout(r, 5 * (attempt + 1)));
    }
  }
}

/** Temp file name next to `file`: `<file>.<pid>.<rand>.tmp`. Anything matching TEMP_SUFFIX is garbage from a crashed writer. */
export const TEMP_SUFFIX = /\.\d+\.[0-9a-f]{8}\.tmp$/;

export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    if (typeof data === 'string') await writeFile(tmp, data, 'utf8');
    else await writeFile(tmp, data);
    await renameWithRetry(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
