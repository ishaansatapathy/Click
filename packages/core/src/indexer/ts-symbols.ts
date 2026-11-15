// SPEC §5.3: top-level symbols of a TS/JS module with 1-based line ranges, a compact signature and the first
// JSDoc line. Used for .ts files and for <script> blocks of SFCs (pass lineOffset so ranges are file-absolute).
//
// What counts as a symbol:
// - every top-level function, class (methods become `Class.method`), interface, type alias and enum;
// - top-level consts/lets initialised with an arrow or function expression, exported or not (helpers matter for `calls` edges);
// - every other exported variable (`export const useXStore = defineStore(...)`, `export const routes = [...]`);
// - `export default <expr>` as a symbol named "default" (or it marks the referenced local as the default export).
// Overloads merge into one symbol whose range spans all declarations.

import ts from 'typescript';
import type { LineRange } from '../types.js';
import { hasModifier, lineOf } from './ts-parse.js';

export type TsSymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'const';
export type InitializerKind = 'arrow' | 'function' | 'call' | 'object' | 'array' | 'literal' | 'other';

export interface TsSymbol {
  name: string; // `Class.method` for methods
  kind: TsSymbolKind;
  exported: boolean;
  isDefault: boolean;
  range: LineRange; // includes the leading JSDoc
  signature: string; // ≤ 300 chars, bodies replaced by "{ … }"
  doc?: string; // first JSDoc line
  parent?: string; // class name, for methods
  initializer?: InitializerKind; // for variables
  callee?: string; // for call initializers: 'defineStore', 'createRouter', 'defineComponent'…
}

export interface SymbolOptions {
  /** Added to every line number, for script blocks embedded in a .vue file. */
  lineOffset?: number;
}

export const MAX_SIGNATURE = 300;

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
export function capSignature(s: string): string {
  const c = collapse(s);
  return c.length <= MAX_SIGNATURE ? c : `${c.slice(0, MAX_SIGNATURE - 1)}…`;
}

function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
  return x;
}

function initializerKind(e: ts.Expression): InitializerKind {
  const x = unwrap(e);
  if (ts.isArrowFunction(x)) return 'arrow';
  if (ts.isFunctionExpression(x)) return 'function';
  if (ts.isCallExpression(x) || ts.isNewExpression(x)) return 'call';
  if (ts.isObjectLiteralExpression(x)) return 'object';
  if (ts.isArrayLiteralExpression(x)) return 'array';
  if (ts.isStringLiteral(x) || ts.isNumericLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) || x.kind === ts.SyntaxKind.TrueKeyword || x.kind === ts.SyntaxKind.FalseKeyword || x.kind === ts.SyntaxKind.NullKeyword) return 'literal';
  return 'other';
}

/** Short, information-dense rendering of an initializer: `defineStore('order', …)`, `[ … ]`, `"/dashboard"`. */
function summarize(e: ts.Expression, sf: ts.SourceFile): string {
  const x = unwrap(e);
  const arg = (a: ts.Expression): string => {
    const u = unwrap(a);
    if (ts.isStringLiteral(u) || ts.isNumericLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return u.getText(sf);
    if (ts.isIdentifier(u) && u.text.length <= 30) return u.text;
    if (ts.isObjectLiteralExpression(u)) return '{ … }';
    if (ts.isArrayLiteralExpression(u)) return '[ … ]';
    return '…';
  };
  if (ts.isCallExpression(x)) return `${x.expression.getText(sf)}(${x.arguments.map(arg).join(', ')})`;
  if (ts.isNewExpression(x)) return `new ${x.expression.getText(sf)}(${(x.arguments ?? []).map(arg).join(', ')})`;
  if (ts.isObjectLiteralExpression(x)) return '{ … }';
  if (ts.isArrayLiteralExpression(x)) return '[ … ]';
  if (initializerKind(x) === 'literal') return x.getText(sf);
  return '…';
}

function calleeName(e: ts.Expression, sf: ts.SourceFile): string | undefined {
  const x = unwrap(e);
  if (ts.isCallExpression(x) || ts.isNewExpression(x)) return x.expression.getText(sf);
  return undefined;
}

function firstDocLine(node: ts.Node): string | undefined {
  for (const d of ts.getJSDocCommentsAndTags(node)) {
    if (!ts.isJSDoc(d)) continue;
    const text = ts.getTextOfJSDocComment(d.comment);
    const line = text?.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (line) return line;
  }
  return undefined;
}

function docStart(node: ts.Node, sf: ts.SourceFile): number {
  const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
  const start = node.getStart(sf);
  return docs.length ? Math.min(start, docs[0]!.getStart(sf)) : start;
}

const memberName = (n: ts.PropertyName | undefined): string | undefined =>
  n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isPrivateIdentifier(n)) ? n.text : undefined;

export function extractTsSymbols(sf: ts.SourceFile, opts: SymbolOptions = {}): TsSymbol[] {
  const offset = opts.lineOffset ?? 0;
  const out: TsSymbol[] = [];
  const range = (startPos: number, endPos: number): LineRange => ({
    startLine: lineOf(sf, startPos) + offset,
    endLine: lineOf(sf, endPos) + offset,
  });
  const head = (from: number, to: number): string => sf.text.slice(from, to);

  // `export { a, b as c }` (no `from`) and `export default a` mark local declarations as exported.
  const localExports = new Set<string>();
  let defaultLocal: string | undefined;
  for (const s of sf.statements) {
    if (ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause)) {
      for (const el of s.exportClause.elements) {
        localExports.add((el.propertyName ?? el.name).text);
        if (el.name.text === 'default') defaultLocal = (el.propertyName ?? el.name).text;
      }
    }
    if (ts.isExportAssignment(s) && !s.isExportEquals && ts.isIdentifier(s.expression)) defaultLocal = s.expression.text;
  }
  const isExported = (node: ts.Node, name: string) =>
    hasModifier(node, ts.SyntaxKind.ExportKeyword) || localExports.has(name) || defaultLocal === name;
  const isDefault = (node: ts.Node, name: string) => hasModifier(node, ts.SyntaxKind.DefaultKeyword) || defaultLocal === name;

  const push = (sym: TsSymbol) => {
    // Overloads: one symbol spanning every declaration, keeping the first declaration's signature.
    const prev = out.find((o) => o.name === sym.name && o.kind === sym.kind && o.parent === sym.parent);
    if (prev && (sym.kind === 'function' || sym.kind === 'method')) {
      prev.range = { startLine: Math.min(prev.range.startLine, sym.range.startLine), endLine: Math.max(prev.range.endLine, sym.range.endLine) };
      prev.doc ??= sym.doc;
      return;
    }
    out.push(sym);
  };

  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s)) {
      const name = s.name?.text ?? (hasModifier(s, ts.SyntaxKind.DefaultKeyword) ? 'default' : undefined);
      if (!name) continue;
      const sig = s.body ? `${head(s.getStart(sf), s.body.getStart(sf))}{ … }` : s.getText(sf);
      push({ name, kind: 'function', exported: isExported(s, name), isDefault: isDefault(s, name), range: range(docStart(s, sf), s.end), signature: capSignature(sig), doc: firstDocLine(s) });
    } else if (ts.isClassDeclaration(s)) {
      const name = s.name?.text ?? (hasModifier(s, ts.SyntaxKind.DefaultKeyword) ? 'default' : undefined);
      if (!name) continue;
      const exported = isExported(s, name);
      push({ name, kind: 'class', exported, isDefault: isDefault(s, name), range: range(docStart(s, sf), s.end), signature: capSignature(`${head(s.getStart(sf), s.members.pos).replace(/\{\s*$/, '')}{ … }`), doc: firstDocLine(s) });
      for (const m of s.members) {
        if (!(ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m))) continue;
        const mName = memberName(m.name);
        if (!mName) continue;
        const sig = m.body ? `${head(m.getStart(sf), m.body.getStart(sf))}{ … }` : m.getText(sf);
        push({ name: `${name}.${mName}`, kind: 'method', exported, isDefault: false, range: range(docStart(m, sf), m.end), signature: capSignature(sig), doc: firstDocLine(m), parent: name });
      }
    } else if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isEnumDeclaration(s)) {
      const name = s.name.text;
      const kind: TsSymbolKind = ts.isInterfaceDeclaration(s) ? 'interface' : ts.isTypeAliasDeclaration(s) ? 'type' : 'enum';
      push({ name, kind, exported: isExported(s, name), isDefault: isDefault(s, name), range: range(docStart(s, sf), s.end), signature: capSignature(s.getText(sf)), doc: firstDocLine(s) });
    } else if (ts.isVariableStatement(s)) {
      const single = s.declarationList.declarations.length === 1;
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const name = d.name.text;
        const init = d.initializer;
        const ik = initializerKind(init);
        const exported = isExported(s, name);
        const isFn = ik === 'arrow' || ik === 'function';
        if (!isFn && !exported) continue;
        const startNode = single ? s : d;
        const fn = unwrap(init);
        let sig: string;
        if (ts.isArrowFunction(fn)) sig = `${head(startNode.getStart(sf), fn.body.getStart(sf))}${ts.isBlock(fn.body) ? '{ … }' : '…'}`;
        else if (ts.isFunctionExpression(fn)) sig = `${head(startNode.getStart(sf), fn.body.getStart(sf))}{ … }`;
        else sig = `${head(startNode.getStart(sf), init.getStart(sf))}${summarize(init, sf)}`;
        push({
          name,
          kind: isFn ? 'function' : 'const',
          exported,
          isDefault: isDefault(s, name),
          range: range(single ? docStart(s, sf) : d.getStart(sf), single ? s.end : d.end),
          signature: capSignature(sig),
          doc: firstDocLine(single ? s : d),
          initializer: ik,
          callee: calleeName(init, sf),
        });
      }
    } else if (ts.isExportAssignment(s) && !s.isExportEquals && !ts.isIdentifier(s.expression)) {
      const ik = initializerKind(s.expression);
      push({
        name: 'default',
        kind: ik === 'arrow' || ik === 'function' ? 'function' : 'const',
        exported: true,
        isDefault: true,
        range: range(docStart(s, sf), s.end),
        signature: capSignature(`export default ${summarize(s.expression, sf)}`),
        doc: firstDocLine(s),
        initializer: ik,
        callee: calleeName(s.expression, sf),
      });
    }
  }
  return out.sort((a, b) => a.range.startLine - b.range.startLine || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
