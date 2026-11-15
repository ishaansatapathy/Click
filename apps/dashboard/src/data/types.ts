// The data contract between the exporter and the dashboard. Every number the pages show comes from these files, which come from
// `bench/results.jsonl` and the run files (the sources of truth). Seat A's export script (prompt 222) and this app's own
// `scripts/build-data.ts` write the same shapes; the loader below refuses data that does not match, so a wrong file is an error
// on the page, not a wrong chart.

export type VariantId = 'oracle' | 'random' | 'V1' | 'V2' | 'V3' | 'V3r' | 'V5' | (string & {});

export interface RunRow {
  /** The row id in bench/results.jsonl. Every figure on the site links back to one of these. */
  id: string;
  variant: VariantId;
  budget: number;
  split: 'test' | 'train' | 'all';
  n: number;
  strict: number;
  any: number;
  symbol: number | null;
  precision: number;
  p50ms: number;
  p95ms: number;
  /** Requests served from the local replica because HydraDB missed its deadline. */
  graphFallback: number;
  ts: string;
}

export interface TypeRow {
  rowId: string;
  type: string;
  n: number;
  strict: number;
}

export interface DiffRow {
  budget: number;
  /** "V3 - V2": the first variant minus the second. */
  label: string;
  a: string;
  b: string;
  aRow: string;
  bRow: string;
  /** 'all' or a task type. */
  group: string;
  n: number;
  delta: number;
  lo: number;
  hi: number;
}

export interface ResultsData {
  generatedAt: string;
  repo: { name: string; url: string; sha: string; files: number; nodes: number; edges: number };
  tasks: { total: number; train: number; test: number; byType: Record<string, number> };
  rows: RunRow[];
  perType: TypeRow[];
  diffs: DiffRow[];
  bootstrap: { iterations: number; seed: number };
}

export interface LearningData {
  /** Everything here was learned from simulated outcomes (the benchmark's own answers), never from a real agent. */
  simulated: true;
  weightsVersion: string;
  events: number;
  multipliers: number;
  learnedEdges: number;
  topUp: { key: string; w: number }[];
  topDown: { key: string; w: number }[];
  /** V5 versus V3 on the held-out test split. */
  rows: { variant: string; budget: number; rowId: string; strict: number; symbol: number | null }[];
  diffs: DiffRow[];
}

export interface GraphNodeView {
  id: string;
  name: string;
  kind: string;
  path: string | null;
}
export interface GraphEdgeView {
  from: string;
  to: string;
  kind: string;
  /** Learned multiplier, when the edge has one. */
  w?: number;
}
export interface GraphData {
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  hubs: { id: string; degree: number }[];
}

export interface ExampleData {
  taskId: string;
  type: string;
  text: string;
  groundTruthFiles: string[];
  seeds: { nodeId: string; name: string; score: number; sources: string[] }[];
  items: { path: string | null; name: string; mode: string; tokens: number; reason: string }[];
  filesFound: string[];
  filesMissed: string[];
  strict: number;
  rowId: string;
  /** The same task answered without the graph (V2), from its own run row. */
  baseline?: { variant: string; strict: number; filesFound: string[]; rowId: string };
}

/** The sample repo for the in-browser demo: its graph and the text of its files. */
export interface DemoRepo {
  name: string;
  sha: string;
  graph: { version: string; nodes: unknown[]; edges: unknown[]; chunks: unknown[] };
  files: Record<string, string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

export class DataError extends Error {
  constructor(file: string, why: string) {
    super(`${file}: ${why}`);
    this.name = 'DataError';
  }
}

export function parseResults(x: unknown): ResultsData {
  if (!isObj(x) || !Array.isArray(x.rows) || !Array.isArray(x.diffs) || !Array.isArray(x.perType) || !isObj(x.repo) || !isObj(x.tasks)) throw new DataError('results.json', 'not a results document');
  const ids = new Set<string>();
  for (const r of x.rows) {
    if (!isObj(r) || !isStr(r.id) || !isStr(r.variant) || !isNum(r.budget) || !isNum(r.n) || !isNum(r.strict) || !isNum(r.any) || !isNum(r.precision) || !isNum(r.p50ms) || !isNum(r.p95ms)) throw new DataError('results.json', `bad row ${JSON.stringify(r).slice(0, 80)}`);
    ids.add(r.id);
  }
  for (const d of x.diffs) {
    if (!isObj(d) || !isNum(d.delta) || !isNum(d.lo) || !isNum(d.hi) || !isStr(d.aRow) || !isStr(d.bRow)) throw new DataError('results.json', 'bad diff');
    if (!ids.has(d.aRow) || !ids.has(d.bRow)) throw new DataError('results.json', `a difference cites a row that is not in the file: ${String(d.aRow)} / ${String(d.bRow)}`);
  }
  for (const t of x.perType) if (!isObj(t) || !ids.has(String(t.rowId))) throw new DataError('results.json', 'a per-type figure cites a row that is not in the file');
  return x as unknown as ResultsData;
}

export function parseLearning(x: unknown): LearningData {
  if (!isObj(x) || x.simulated !== true || !isStr(x.weightsVersion) || !Array.isArray(x.rows)) throw new DataError('learning.json', 'not a (simulated) learning document');
  return x as unknown as LearningData;
}

export function parseGraph(x: unknown): GraphData {
  if (!isObj(x) || !Array.isArray(x.nodes) || !Array.isArray(x.edges)) throw new DataError('graph.json', 'not a graph document');
  return x as unknown as GraphData;
}

export function parseExamples(x: unknown): ExampleData[] {
  if (!Array.isArray(x)) throw new DataError('examples.json', 'not a list');
  for (const e of x) if (!isObj(e) || !isStr(e.taskId) || !isStr(e.text) || !Array.isArray(e.items)) throw new DataError('examples.json', 'bad example');
  return x as ExampleData[];
}

export interface DashboardData {
  results: ResultsData;
  learning: LearningData | null;
  graph: GraphData | null;
  examples: ExampleData[];
}

/** Fetch and validate all data files. results.json is required; the others degrade to "not available yet". */
export async function loadData(base: string = import.meta.env.BASE_URL, fetcher: typeof fetch = fetch): Promise<DashboardData> {
  const get = async (name: string): Promise<unknown> => {
    const res = await fetcher(`${base}data/${name}`, { cache: 'no-cache' });
    if (!res.ok) throw new DataError(name, `HTTP ${res.status}`);
    return res.json();
  };
  const optional = async <T>(name: string, parse: (x: unknown) => T): Promise<T | null> => {
    try {
      return parse(await get(name));
    } catch {
      return null;
    }
  };
  const results = parseResults(await get('results.json'));
  const [learning, graph, examples] = await Promise.all([optional('learning.json', parseLearning), optional('graph.json', parseGraph), optional('examples.json', parseExamples)]);
  return { results, learning, graph, examples: examples ?? [] };
}
