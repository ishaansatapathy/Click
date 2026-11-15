// PROMPTS 053 / SPEC §5.5: cAST-style chunks (AST-aligned, size-bounded) for semantic seeds and the V1 baseline.
//   - one chunk per top-level unit (symbol, SFC script block, SFC template);
//   - a unit over MAX tokens splits only at statement boundaries (never mid-statement);
//   - adjacent tiny chunks (< MIN tokens) merge, up to a cap, into one `_file` chunk owned by the fallback node;
//   - a file with no units is one `_file` chunk; style blocks are never chunked;
//   - ids are chunk:<path>#<label>#<n>, with n counted per label, so editing one symbol never renames another's chunks.

import ts from 'typescript';
import type { ChunkRecord, LineRange } from '../types.js';
import { chunkId } from '../util/ids.js';
import { countTokens } from '../util/tokens.js';
import { lineOf, unwrap } from './ts-parse.js';
import { docStart } from './ts-symbols.js';

export const MAX_CHUNK_TOKENS = 400;
export const MIN_CHUNK_TOKENS = 60;
export const MERGE_CAP_TOKENS = 200;

export interface ChunkUnit {
  nodeId: string;
  name: string; // label in the chunk id (symbol name, component name, '_template')
  range: LineRange; // file-absolute, 1-based, inclusive
  /** Lines where a split is allowed (statement starts). Falls back to "after a blank line". */
  boundaries?: number[];
}

export interface ChunkInput {
  path: string;
  content: string; // normalised (LF)
  /** Node that owns `_file` chunks: the file node, or the component node for an SFC. */
  fallbackNodeId: string;
  units: ChunkUnit[];
  template?: ChunkUnit;
}

interface Piece {
  nodeId: string;
  label: string;
  start: number;
  end: number;
  tokens: number;
}

const FILE_LABEL = '_file';

export function chunkFile(input: ChunkInput): ChunkRecord[] {
  const lines = input.content.split('\n');
  const total = input.content.endsWith('\n') ? lines.length - 1 : lines.length;
  const text = (a: number, b: number): string => lines.slice(a - 1, b).join('\n');
  const tok = (a: number, b: number): number => countTokens(text(a, b));

  const pieces: Piece[] = [];
  const addUnit = (u: ChunkUnit): void => {
    for (const [a, b] of splitRange(u.range, u.boundaries ?? softBoundaries(lines, u.range), tok)) {
      pieces.push({ nodeId: u.nodeId, label: u.name, start: a, end: b, tokens: tok(a, b) });
    }
  };

  const units = [...input.units].sort((a, b) => a.range.startLine - b.range.startLine);
  if (units.length === 0 && !input.template) {
    if (total >= 1 && text(1, total).trim() !== '') addUnit({ nodeId: input.fallbackNodeId, name: FILE_LABEL, range: { startLine: 1, endLine: total } });
  }
  for (const u of units) addUnit(u);
  if (input.template) addUnit(input.template);
  pieces.sort((a, b) => a.start - b.start);

  const merged: Piece[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.tokens < MIN_CHUNK_TOKENS && p.tokens < MIN_CHUNK_TOKENS && last.tokens + p.tokens <= MERGE_CAP_TOKENS) {
      const same = last.nodeId === p.nodeId && last.label === p.label;
      merged[merged.length - 1] = {
        nodeId: same ? last.nodeId : input.fallbackNodeId,
        label: same ? last.label : FILE_LABEL,
        start: last.start,
        end: p.end,
        tokens: tok(last.start, p.end),
      };
    } else {
      merged.push(p);
    }
  }

  const counters = new Map<string, number>();
  return merged.map((p) => {
    const n = counters.get(p.label) ?? 0;
    counters.set(p.label, n + 1);
    return {
      id: chunkId(input.path, p.label, n),
      nodeId: p.nodeId,
      path: input.path,
      range: { startLine: p.start, endLine: p.end },
      text: text(p.start, p.end),
    };
  });
}

/** Greedy split of [range] at the allowed boundaries into parts of at most MAX tokens (a single oversized part stays whole). */
export function splitRange(range: LineRange, boundaries: number[], tok: (a: number, b: number) => number): [number, number][] {
  const { startLine: a, endLine: b } = range;
  if (tok(a, b) <= MAX_CHUNK_TOKENS) return [[a, b]];
  const cuts = [...new Set([a, ...boundaries.filter((l) => l > a && l <= b), b + 1])].sort((x, y) => x - y);
  const parts: [number, number][] = [];
  let cur = a;
  let acc = 0;
  for (let i = 0; i < cuts.length - 1; i++) {
    const s = cuts[i]!;
    const e = cuts[i + 1]! - 1;
    const t = tok(s, e);
    if (acc > 0 && acc + t > MAX_CHUNK_TOKENS) {
      parts.push([cur, s - 1]);
      cur = s;
      acc = 0;
    }
    acc += t;
  }
  parts.push([cur, b]);
  return parts;
}

/** Fallback split points when no AST boundaries exist: the first non-blank line after a blank line. */
export function softBoundaries(lines: string[], range: LineRange): number[] {
  const out: number[] = [];
  for (let l = range.startLine + 1; l <= range.endLine; l++) {
    if ((lines[l - 2] ?? '').trim() === '' && (lines[l - 1] ?? '').trim() !== '') out.push(l);
  }
  return out;
}

// ---------------------------------------------------------------- AST boundaries

/** Start lines (JSDoc-inclusive) of the statements one level inside the top-level statements that start in `range`. */
export function statementBoundaries(sf: ts.SourceFile, range: LineRange, lineOffset = 0): number[] {
  const out = new Set<number>();
  const startOf = (n: ts.Node): number => lineOf(sf, docStart(n, sf)) + lineOffset;
  const addAll = (nodes: readonly ts.Node[]): void => nodes.forEach((n) => out.add(startOf(n)));

  const drill = (e: ts.Expression): void => {
    const x = unwrap(e);
    if ((ts.isArrowFunction(x) || ts.isFunctionExpression(x)) && ts.isBlock(x.body)) addAll(x.body.statements);
    else if (ts.isCallExpression(x) || ts.isNewExpression(x)) (x.arguments ?? []).forEach(drill);
    else if (ts.isObjectLiteralExpression(x)) addAll(x.properties);
  };

  for (const top of sf.statements) {
    const s = startOf(top);
    if (s < range.startLine || s > range.endLine) continue;
    if (ts.isFunctionDeclaration(top) && top.body) addAll(top.body.statements);
    else if (ts.isClassDeclaration(top)) addAll(top.members);
    else if (ts.isVariableStatement(top)) top.declarationList.declarations.forEach((d) => d.initializer && drill(d.initializer));
    else if (ts.isExportAssignment(top)) drill(top.expression);
  }
  return [...out].sort((a, b) => a - b);
}

/** Start lines of every top-level statement of a script block (for splitting an oversized SFC script). */
export function topLevelBoundaries(sf: ts.SourceFile, lineOffset = 0): number[] {
  return sf.statements.map((s) => lineOf(sf, docStart(s, sf)) + lineOffset);
}
