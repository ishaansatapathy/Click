// PROMPTS 116 / 178: build the shippable files with esbuild.
//   dist/hooks/stop.js     the Stop hook, same rules
//   dist/hooks/prompt.js   everything inlined, no dependencies: it starts on every prompt, so it must start fast
//   dist/click.js          the CLI and daemon; the TypeScript and Vue compilers stay external (dependencies of the package)
// More entries (hooks/stop.js, mcp.js) are added by their prompts.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type BuildOptions } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
export const SRC = join(here, '..');
export const DEFAULT_OUT = join(here, '..', '..', 'dist');

/** The compilers the indexer drives are huge and read their own files (__filename), so they stay real dependencies of the package. */
const EXTERNAL = ['typescript', '@vue/compiler-sfc', '@vue/compiler-core'];

const common: BuildOptions = { bundle: true, platform: 'node', format: 'esm', target: 'node20', sourcemap: false, logLevel: 'silent' };

export interface BundleOptions {
  outdir?: string;
  /** Only the hooks (fast, used by tests). */
  hooksOnly?: boolean;
}

export async function bundle(o: BundleOptions = {}): Promise<{ outdir: string; files: string[] }> {
  const outdir = o.outdir ?? DEFAULT_OUT;
  const files: string[] = [];
  // .js files in dist are ES modules wherever dist ends up (no "typeless package" warning on stderr when it is copied around)
  await mkdir(outdir, { recursive: true });
  await writeFile(join(outdir, 'package.json'), '{ "type": "module" }\n');
  const hook = join(outdir, 'hooks', 'prompt.js');
  await build({ ...common, entryPoints: [join(SRC, 'hooks', 'prompt-bin.ts')], outfile: hook, minify: true });
  files.push(hook);
  const stop = join(outdir, 'hooks', 'stop.js');
  await build({ ...common, entryPoints: [join(SRC, 'hooks', 'stop-bin.ts')], outfile: stop, minify: true });
  files.push(stop);
  if (!o.hooksOnly) {
    const cli = join(outdir, 'click.js');
    // everything inlined except the compilers; CommonJS dependencies inside an ES module bundle need `require`, so it is provided
    const banner = ['#!/usr/bin/env node', "import { createRequire as __cr } from 'node:module';", 'const require = __cr(import.meta.url);'].join('\n');
    await build({ ...common, entryPoints: [join(SRC, 'cli', 'index.ts')], outfile: cli, banner: { js: banner }, external: EXTERNAL });
    files.push(cli);
  }
  return { outdir, files };
}
