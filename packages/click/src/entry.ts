import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Is this module the program being run? npm installs bins as SYMLINKS on Linux and macOS (a .cmd shim on Windows), so argv[1]
 * is the link, not the file: compare real paths, or the command silently does nothing.
 */
export function isEntryPoint(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argv1));
  } catch {
    return metaUrl === pathToFileURL(resolve(argv1)).href;
  }
}
