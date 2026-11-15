// FROZEN CONTRACT (PLAN §14.4). Changes only through a contract change (PLAN §14.8).
// Cross-lane types: whatever one lane implements and the other consumes lives here, so both lanes
// can build in parallel against the same shapes. Sources: SPEC §5.6, §5.8, §14.

import type { VariantConfig } from './config.js';
import type { Embedder, GraphStore, Store } from './store/types.js';
import type {
  ChunkRecord,
  EdgeKind,
  Graph,
  GraphEdge,
  GraphNode,
  PackMode,
  PackedContext,
  Task,
} from './types.js';

// ---------------------------------------------------------------- repo profile (SPEC §5.8)

/** Implemented by Lane A (indexer/profile.ts); consumed by the Lane B indexer. */
export type { RepoProfile } from './indexer/profile.js';
import type { RepoProfile } from './indexer/profile.js';
import type { RouteDef } from './indexer/router.js';

// ---------------------------------------------------------------- extraction (SPEC §5.6)

export type FileClass = 'src' | 'test' | 'generated' | 'config';

export interface SourceFile {
  path: string; // posix, repo-relative
  content: string;
  hash: string;
  class: FileClass;
}

/** A component reachable from templates: the file that exports it and the export name ('default' for a .vue file). */
export interface ComponentTarget {
  path: string;
  exportName: string;
}

/** Globally registered components (`app.component('Name', Comp)`), by PascalCase name. */
export type GlobalComponents = ReadonlyMap<string, ComponentTarget | { pkg: string }>;

/**
 * contract/2: extraction needs the repo's file list (import resolution) and the global component registrations
 * (template tag resolution). Both are inputs of the content-addressed extract cache key.
 */
export interface ExtractCtx {
  root: string;
  profile: RepoProfile;
  profileHash: string;
  allPaths: ReadonlySet<string>; // every repo file (assets included), posix and repo-relative
  globals: GlobalComponents;
}

export type Resolved =
  | { kind: 'local'; path: string }
  | { kind: 'external'; pkg: string }
  | { kind: 'unresolved'; spec: string };

export interface ImportRef {
  spec: string; // the specifier as written
  resolved: Resolved;
  kind: 'static' | 'dynamic' | 'reexport';
  names: { imported: string; local: string; typeOnly: boolean }[]; // imported = 'default' | '*' | name
}

/** An edge whose target is a symbol in another file, resolved later by link.ts. */
export interface SymbolRef {
  from: string; // node id in this file
  kind: EdgeKind;
  targetPath: string; // resolved local path of the imported module
  targetName: string; // exported name ('default' for default exports)
  meta?: GraphEdge['meta'];
}

export interface FileExtract {
  nodes: GraphNode[];
  edges: GraphEdge[]; // edges fully resolved within this file
  refs: SymbolRef[]; // cross-file edges awaiting link.ts
  chunks: ChunkRecord[];
  imports: ImportRef[];
  unresolved: string[]; // import specifiers that were meant to be local but did not resolve
  routes: RouteDef[]; // raw route tables (contract/2); paths are finalised by link.ts
}

/** Implemented by Lane B (indexer/extract.ts). Lane A uses it for ground-truth symbol ranges (070). Pure. */
export type ExtractFile = (file: SourceFile, ctx: ExtractCtx) => FileExtract;

/** Implemented by Lane B (indexer/build.ts). Lane A uses it to classify tasks (071). */
export type BuildGraph = (root: string, profile: RepoProfile) => Promise<Graph>;

// ---------------------------------------------------------------- logs (SPEC §14)

export interface ContextRecord {
  v: 1;
  contextId: string;
  ts: string;
  sessionId?: string;
  source: string;
  variant: string;
  configHash: string;
  graphVersion: string;
  weightsVersion: string | null;
  taskText: string;
  taskHash: string;
  repoCommit: string | null;
  seeds: { nodeId: string; score: number }[];
  items: { nodeId: string; mode: PackMode }[];
  attribution: Record<string, string[]>; // nodeId → edge keys (seed → node)
  tokens: number;
  ms: number;
  degraded: string[];
}

export type CheckKind = 'vue-tsc' | 'vitest' | 'vue-tsc+vitest' | 'none';
export type OutcomeSource = 'agent' | 'bench-sim' | 'bench-e2e';

export interface OutcomeEvent {
  v: 1;
  type: 'outcome';
  id: string;
  ts: string;
  source: OutcomeSource;
  sessionId?: string;
  contextIds: string[];
  taskText?: string;
  filesRead: string[];
  filesEdited: string[];
  diffSymbols: string[];
  check: { kind: CheckKind; files?: string[]; passed?: boolean };
  repoCommit: string | null;
}

export interface CheckResultEvent {
  v: 1;
  type: 'check_result';
  id: string;
  ts: string;
  outcomeId: string;
  passed: boolean;
  ms: number;
  summary?: string;
}

export type LogEvent = OutcomeEvent | CheckResultEvent;

// ---------------------------------------------------------------- pipeline (SPEC §6, ARCHITECTURE §6)

export interface PipelineDeps {
  store: Store; // chunks + semantic index (local)
  /** contract/1: HydraDB (or a fake). Absent or failing → the pipeline falls back to the local graph replica. */
  graph?: GraphStore;
  embedder?: Embedder;
  root: string;
  now?: () => number;
}

/** Implemented by Lane B (pipeline.ts). Lane A's benchmark calls it in-process (029b). */
export type GetContext = (
  task: Task,
  cfg: VariantConfig,
  deps: PipelineDeps,
) => Promise<{ packed: PackedContext; record: ContextRecord }>;
