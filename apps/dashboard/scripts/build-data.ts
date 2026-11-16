// Builds the dashboard's data files from the benchmark's own outputs. Nothing is typed in by hand: every row is a line of
// bench/results.jsonl, every difference is a paired bootstrap over the per-task rows in bench/runs/<runId>.jsonl.
//   pnpm --filter @click/dashboard data
// Seat A's export (prompt 222) writes the same shapes; whichever runs last wins, and the page validates both the same way.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairedBootstrap } from '../../../bench/src/metrics.js';
import { normaliseContent } from '../../../packages/core/src/indexer/discover.js';
import { buildIndex } from '../../../packages/core/src/indexer/build.js';
import type { DiffRow, E2eData, ExampleData, GraphData, LearningData, ResultsData, RunRow, TypeRow } from '../src/data/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const OUT = join(here, '../public/data');

/** The headline runs: the ones the site and the README quote. Everything else in results.jsonl is exploration. */
export const HEADLINE: { id: string; label: string }[] = [
  { id: '20261115T145947610Z-33e51b', label: 'oracle' },
  { id: '20261115T150006538Z-2f88cb', label: 'oracle' },
  { id: '20261115T150738129Z-5a6e64', label: 'random' },
  { id: '20261115T150828512Z-56bfc3', label: 'random' },
  { id: '20261115T183611846Z-6d101c', label: 'V1' },
  { id: '20261115T183925911Z-34e024', label: 'V1' },
  { id: '20261115T183647313Z-029719', label: 'V2' },
  { id: '20261115T183702220Z-208533', label: 'V2' },
  { id: '20261115T183729476Z-f5748a', label: 'V3' },
  { id: '20261115T183755417Z-9699b6', label: 'V3' },
  { id: '20261115T183818865Z-0e56d6', label: 'V3r' },
  { id: '20261115T183841981Z-d358fc', label: 'V3r' },
  { id: '20261115T194252351Z-cd18d5', label: 'V5' },
  { id: '20261115T194305720Z-dcaa93', label: 'V5' },
];

interface ResultLine {
  runId: string;
  ts: string;
  variant: string;
  budget: number;
  split: 'test' | 'train' | 'all';
  n: number;
  metrics: { recallStrict: number; recallAny: number; symbolRecall?: number; precisionTokens: number; p50ms: number; p95ms: number };
  perType: Record<string, { n: number; recallStrict: number }>;
  degraded: Record<string, number>;
}
interface TaskLine {
  taskId: string;
  type: string;
  recallStrict: number;
  groundTruthFiles: string[];
  missingGroundTruthFiles: string[];
  items: { nodeId: string; path: string | null; name: string; mode: string; tokens: number }[];
}

const readJsonl = <T>(file: string): T[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

const results = readJsonl<ResultLine>(join(ROOT, 'bench/results.jsonl'));
const byId = new Map(results.map((r) => [r.runId, r]));
const taskRows = (id: string): Map<string, TaskLine> => new Map(readJsonl<TaskLine>(join(ROOT, 'bench/runs', `${id}.jsonl`)).map((t) => [t.taskId, t]));

export function pick(variant: string, budget: number): string {
  const h = HEADLINE.find((x) => x.label === variant && byId.get(x.id)?.budget === budget);
  if (!h) throw new Error(`no headline run for ${variant} @ ${budget}`);
  return h.id;
}

export function diff(aVar: string, bVar: string, budget: number, group: string, iterations = 10_000, seed = 42): DiffRow {
  const aId = pick(aVar, budget);
  const bId = pick(bVar, budget);
  const a = taskRows(aId);
  const b = taskRows(bId);
  const ids = [...a.keys()].filter((id) => b.has(id) && (group === 'all' || a.get(id)!.type === group)).sort();
  if (!ids.length) throw new Error(`no paired tasks for ${aVar}/${bVar} ${group}`);
  const r = pairedBootstrap(
    ids.map((i) => a.get(i)!.recallStrict),
    ids.map((i) => b.get(i)!.recallStrict),
    iterations,
    seed,
  );
  // pairedBootstrap(a, b) is b - a; the label reads "first minus second", so pass the first variant as `b`.
  return { budget, label: `${aVar} - ${bVar}`, a: aVar, b: bVar, aRow: aId, bRow: bId, group, n: ids.length, delta: -r.diff, lo: -r.hi, hi: -r.lo };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const rows: RunRow[] = HEADLINE.map(({ id, label }) => {
    const r = byId.get(id);
    if (!r) throw new Error(`headline run ${id} is not in bench/results.jsonl`);
    return {
      id,
      variant: label,
      budget: r.budget,
      split: r.split,
      n: r.n,
      strict: r.metrics.recallStrict,
      any: r.metrics.recallAny,
      symbol: r.metrics.symbolRecall ?? null,
      precision: r.metrics.precisionTokens,
      p50ms: r.metrics.p50ms,
      p95ms: r.metrics.p95ms,
      graphFallback: r.degraded['graph-replica'] ?? 0,
      ts: r.ts,
    };
  });
  const perType: TypeRow[] = HEADLINE.flatMap(({ id }) => Object.entries(byId.get(id)!.perType).map(([type, v]) => ({ rowId: id, type, n: v.n, strict: v.recallStrict })));

  const diffs: DiffRow[] = [];
  const pairs: [string, string][] = [['V3', 'V2'], ['V3', 'V1'], ['V3r', 'V3']];
  for (const budget of [4000, 8000]) {
    for (const [a, b] of pairs) {
      diffs.push(diff(a, b, budget, 'all'));
      for (const type of ['impact', 'multi-hop', 'multi-file', 'single-file']) diffs.push(diff(a, b, budget, type));
    }
  }
  const learningDiffs: DiffRow[] = [];
  for (const budget of [4000, 8000]) {
    learningDiffs.push(diff('V5', 'V3', budget, 'all'));
    for (const type of ['impact', 'multi-hop']) learningDiffs.push(diff('V5', 'V3', budget, type));
  }

  const oracle = byId.get(pick('oracle', 4000))!;
  const test = byId.get(pick('V3', 4000))!;
  const byType: Record<string, number> = {};
  for (const [t, v] of Object.entries(oracle.perType)) byType[t] = v.n;

  const build = await buildIndex(join(ROOT, 'bench/repo'), undefined, { cache: false });
  const graph = build.graph;
  const repo: ResultsData['repo'] = {
    name: 'v3-admin-vite',
    url: 'https://github.com/un-pany/v3-admin-vite',
    sha: graph.repoCommit ?? 'unknown',
    files: build.stats.files,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
  };
  const data: ResultsData = {
    generatedAt: new Date().toISOString(),
    repo,
    tasks: { total: oracle.n, train: oracle.n - test.n, test: test.n, byType },
    rows,
    perType,
    diffs,
    bootstrap: { iterations: 10_000, seed: 42 },
  };
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(data));

  // e2e: the newest real-agent run in results.jsonl (kind "e2e"), both variants of the same run; absent when there is none
  const e2eRows = readJsonl<Record<string, unknown>>(join(ROOT, 'bench/results.jsonl')).filter((r) => r.kind === 'e2e');
  const newest = e2eRows.map((r) => String(r.runId).replace(/-(V0|delivery)$/, '')).sort().pop();
  if (newest) {
    const mine = e2eRows.filter((r) => String(r.runId).startsWith(newest + '-'));
    const e2e: E2eData = {
      ts: String(mine[0]!.ts),
      rows: mine.map((r) => ({ id: String(r.runId), variant: String(r.variant), n: Number(r.n), solved: Number(r.solved), tokensPerSolved: typeof r.tokensPerSolved === 'number' ? r.tokensPerSolved : null, totals: r.totals as E2eData['rows'][number]['totals'] })),
    };
    writeFileSync(join(OUT, 'e2e.json'), JSON.stringify(e2e));
  }

  // learning: the simulated outcomes the V5 weights were derived from (bench/data/bench-sim-weights.json)
  const w = JSON.parse(readFileSync(join(ROOT, 'bench/data/bench-sim-weights.json'), 'utf8')) as { version: string; events: number; multipliers: Record<string, number>; addedEdges?: unknown[]; edges?: unknown[] };
  const entries = Object.entries(w.multipliers).map(([key, m]) => ({ key, w: m }));
  const learned = w.addedEdges ?? w.edges ?? [];
  const learning: LearningData = {
    simulated: true,
    weightsVersion: w.version,
    events: w.events,
    multipliers: entries.length,
    learnedEdges: learned.length,
    topUp: [...entries].sort((a, b) => b.w - a.w).slice(0, 8),
    topDown: [...entries].sort((a, b) => a.w - b.w).slice(0, 8),
    rows: rows.filter((r) => r.variant === 'V3' || r.variant === 'V5').map((r) => ({ variant: r.variant, budget: r.budget, rowId: r.id, strict: r.strict, symbol: r.symbol })),
    diffs: learningDiffs,
  };
  writeFileSync(join(OUT, 'learning.json'), JSON.stringify(learning));

  // graph explorer: file-level graph (symbols folded into their file) keeps it readable and small
  const files = graph.nodes.filter((n) => n.kind === 'file');
  const fileIds = new Set(files.map((f) => f.id));
  const owner = new Map<string, string>();
  for (const n of graph.nodes) if (n.path && n.kind !== 'file') owner.set(n.id, `file:${n.path}`);
  const mapId = (id: string): string | null => (fileIds.has(id) ? id : (owner.get(id) ?? null));
  const seen = new Set<string>();
  const edges: GraphData['edges'] = [];
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.kind === 'contains') continue;
    const from = mapId(e.from);
    const to = mapId(e.to);
    if (!from || !to || from === to) continue;
    const k = `${from}|${e.kind}|${to}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push({ from, to, kind: e.kind });
    degree.set(from, (degree.get(from) ?? 0) + 1);
    degree.set(to, (degree.get(to) ?? 0) + 1);
  }
  const gdata: GraphData = {
    nodes: files.map((f) => ({ id: f.id, name: f.name, kind: f.kind, path: f.path })),
    edges,
    hubs: [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, d]) => ({ id, degree: d })),
  };
  writeFileSync(join(OUT, 'graph.json'), JSON.stringify(gdata));
  // the demo repo: its graph and the text of every indexed file, so the browser can run the retrieval code itself
  const demoFiles: Record<string, string> = {};
  for (const f of files) if (f.path) demoFiles[f.path] = normaliseContent(readFileSync(join(ROOT, 'bench/repo', f.path), 'utf8'));
  writeFileSync(join(OUT, 'demo.json'), JSON.stringify({ name: repo.name, sha: repo.sha, graph, files: demoFiles }));

  // examples: real held-out tasks, V3 at 8k next to the same task without the graph (V2). Wins first, then one honest miss.
  const texts = new Map<string, string>();
  for (const t of readJsonl<{ id: string; text: string }>(join(ROOT, 'bench/tasks/hand/candidates.jsonl'))) texts.set(t.id, t.text);
  const v3Rows = taskRows(pick('V3', 8000));
  const v2Rows = taskRows(pick('V2', 8000));
  const taskText = (id: string): string => {
    const hit = texts.get(id);
    if (hit) return hit;
    const f = join(ROOT, 'bench/tasks/mined', `${id}.json`);
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { text: string }).text : '';
  };
  const asExample = (id: string): ExampleData => {
    const t = v3Rows.get(id)!;
    const b = v2Rows.get(id)!;
    return {
      taskId: id, type: t.type, text: taskText(id), groundTruthFiles: t.groundTruthFiles, seeds: [],
      items: t.items.map((i) => ({ path: i.path, name: i.name, mode: i.mode, tokens: i.tokens, reason: '' })),
      filesFound: t.groundTruthFiles.filter((g) => !t.missingGroundTruthFiles.includes(g)), filesMissed: t.missingGroundTruthFiles,
      strict: t.recallStrict, rowId: pick('V3', 8000),
      baseline: { variant: 'V2', strict: b.recallStrict, filesFound: b.groundTruthFiles.filter((g) => !b.missingGroundTruthFiles.includes(g)), rowId: pick('V2', 8000) },
    };
  };
  const ids = [...v3Rows.keys()].filter((id) => v2Rows.has(id) && taskText(id));
  const wins = ids.filter((id) => v3Rows.get(id)!.recallStrict === 1 && v2Rows.get(id)!.recallStrict < 1 && v3Rows.get(id)!.groundTruthFiles.length >= 3).sort((a, b) => v3Rows.get(b)!.groundTruthFiles.length - v3Rows.get(a)!.groundTruthFiles.length).slice(0, 4);
  const misses = ids.filter((id) => v3Rows.get(id)!.recallStrict < 0.5).slice(0, 1);
  writeFileSync(join(OUT, 'examples.json'), JSON.stringify([...wins, ...misses].map(asExample)));
  console.log(`dashboard data: ${rows.length} rows, ${diffs.length} differences, ${gdata.nodes.length} files, ${gdata.edges.length} file edges -> ${OUT}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
