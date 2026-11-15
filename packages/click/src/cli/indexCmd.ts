// PROMPTS 115: `click index [--full]` builds the code graph and saves it locally (snapshot + local store), without HydraDB.
// With a daemon running, the daemon does the work instead (it owns the graph), via /reindex.
//   --full  ignore the extract cache and rebuild everything

import { resolve } from 'node:path';
import { buildIndex, type BuildResult } from '../../../core/src/indexer/build.js';
import { MemoryStore } from '../../../core/src/store/memory.js';
import type { Store } from '../../../core/src/store/types.js';
import { createLogger } from '../../../core/src/util/log.js';
import { ClickClient } from '../client.js';
import { Persister } from '../daemon/persist.js';
import { parseArgs } from './args.js';
import { pushPaths } from './push-state.js';

export interface IndexIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const INDEX_USAGE = 'usage: click index [--full] [--root <dir>]';

export async function runIndex(argv: readonly string[], io: IndexIo, cwd: string = process.cwd(), deps: { client?: ClickClient; store?: Store; build?: (root: string, o: { cache: boolean }) => Promise<BuildResult> } = {}): Promise<number> {
  const p = parseArgs(argv, { full: 'bool', root: 'string' });
  if (p.error || p.positionals.length) {
    io.err(`${p.error ?? `unexpected argument ${p.positionals[0]}`}\n${INDEX_USAGE}`);
    return 2;
  }
  const root = resolve(cwd, p.flags.root ?? '.');
  const client = deps.client ?? new ClickClient({ root });
  if (await client.discover()) {
    try {
      await client.request('/reindex', { body: p.flags.full ? { full: true } : {}, deadlineMs: 5_000 });
      io.out('the daemon is running: it will re-index and keep its graph current (see `click status`)');
      return 0;
    } catch (e) {
      io.err(`could not reach the running daemon (${e instanceof Error ? e.message : String(e)}); indexing locally`);
    }
  }
  const t0 = performance.now();
  const build = await (deps.build ?? ((r, o) => buildIndex(r, undefined, { cache: o.cache })))(root, { cache: !p.flags.full });
  const store = deps.store ?? new MemoryStore(pushPaths(root).memstore);
  const persist = new Persister({ root, store, sync: null, log: createLogger('index', { dir: `${pushPaths(root).dir}/logs` }) });
  await persist.saveFull(build.graph, build.chunks, build.conventions);
  io.out(`Indexed ${build.stats.files} files in ${Math.round(performance.now() - t0)} ms: ${build.graph.nodes.length} nodes, ${build.graph.edges.length} edges, ${build.chunks.length} chunks · graph ${build.graph.version}${p.flags.full ? ' (full rebuild)' : ` (extract cache ${build.stats.extractCacheHits} hit / ${build.stats.extractCacheMisses} miss)`}`);
  return 0;
}
