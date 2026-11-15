// PROMPTS 116 / 178: build the shippable files with esbuild.
//   dist/hooks/prompt.js   everything inlined, no dependencies: it starts on every prompt, so it must start fast
//   dist/click.js          the CLI and daemon; npm packages stay external (resolved from node_modules at run time)
// More entries (hooks/stop.js, mcp.js) are added by their prompts.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type BuildOptions } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
export const SRC = join(here, '..');
export const DEFAULT_OUT = join(here, '..', '..', 'dist');

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
  if (!o.hooksOnly) {
    const cli = join(outdir, 'click.js');
    await build({ ...common, entryPoints: [join(SRC, 'cli', 'index.ts')], outfile: cli, packages: 'external', banner: { js: '#!/usr/bin/env node' } });
    files.push(cli);
  }
  return { outdir, files };
}
