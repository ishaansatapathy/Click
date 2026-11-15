// PROMPTS 049: who uses what, at symbol level.
// For every value identifier in a script that refers to an imported local binding (or to another top-level
// symbol of the same file), emit an edge from the enclosing top-level symbol (else the file/component node).
//   - cross-file → SymbolRef for link.ts;  same-file → GraphEdge directly.
//   - kind by name: use…Store() → uses_store, use[A-Z]… → uses_composable, everything else → calls
//     ("calls" also covers plain value references, e.g. `createRouter({ routes })`).
//   Convention: link.ts re-derives the kind from the target node's kind (store / composable / component), so a
//   misleading name never produces a wrong edge kind.
// Type positions, declaration names, property names and type-only imports are ignored. Shadowing is not tracked.

import ts from 'typescript';
import type { SymbolRef } from '../contracts.js';
import type { EdgeKind, GraphEdge } from '../types.js';
import { edgeKey, symId } from '../util/ids.js';
import { isIndexedPath } from './discover.js';
import type { Resolver } from './resolve.js';
import type { RawImport } from './ts-imports.js';
import type { TsSymbol } from './ts-symbols.js';

export interface UsageCtx {
  path: string;
  resolve: Resolver;
  imports: RawImport[];
  symbols: TsSymbol[]; // symbols of this script (for owners and same-file edges)
  ownerDefault: string; // file node (TS) or component node (SFC) for top-level code
}

export interface UsageResult {
  refs: SymbolRef[];
  edges: GraphEdge[];
}

interface Binding {
  targetPath: string;
  targetName: string; // 'default' | named export | '*' for namespace
}

const STORE_NAME = /^use\w*Store$/;
const COMPOSABLE_NAME = /^use[A-Z0-9]/;

export function kindForName(name: string): EdgeKind {
  if (STORE_NAME.test(name)) return 'uses_store';
  if (COMPOSABLE_NAME.test(name)) return 'uses_composable';
  return 'calls';
}

function kindForLocal(s: TsSymbol): EdgeKind {
  if (s.callee === 'defineStore') return 'uses_store';
  if (s.kind === 'function' && COMPOSABLE_NAME.test(s.name)) return 'uses_composable';
  return 'calls';
}

/** Value bindings created by this script's static imports that resolve inside the repo. */
export function localImportBindings(imports: RawImport[], resolve: Resolver, path: string): Map<string, Binding> {
  const m = new Map<string, Binding>();
  for (const imp of imports) {
    if (imp.kind !== 'static') continue;
    const r = resolve(imp.spec, path);
    if (r.kind !== 'local' || !isIndexedPath(r.path)) continue; // assets (images, styles, json) are not graph nodes
    for (const n of imp.names) if (!n.typeOnly) m.set(n.local, { targetPath: r.path, targetName: n.imported });
  }
  return m;
}

function inTypePosition(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isTypeNode(p) && !ts.isExpressionWithTypeArguments(p)) return true;
    if (ts.isStatement(p) || ts.isBlock(p)) return false;
  }
  return false;
}

/** True when the identifier is a value reference, not a declaration name or property key. */
function isValueReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isEnumMember(p)) && p.name === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isEnumDeclaration(p) || ts.isTypeParameterDeclaration(p)) && p.name === id) return false;
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  if (ts.isQualifiedName(p)) return false;
  return !inTypePosition(id);
}

export function extractUsages(sf: ts.SourceFile, ctx: UsageCtx): UsageResult {
  const imports = localImportBindings(ctx.imports, ctx.resolve, ctx.path);
  const localSyms = new Map(ctx.symbols.filter((s) => s.kind !== 'method').map((s) => [s.name, s]));
  const refs = new Map<string, SymbolRef>();
  const edges = new Map<string, GraphEdge>();

  const addRef = (from: string, b: Binding, name: string) => {
    const kind = kindForName(name);
    const key = `${from}|${kind}|${b.targetPath}#${b.targetName}`;
    if (!refs.has(key)) refs.set(key, { from, kind, targetPath: b.targetPath, targetName: b.targetName, meta: { source: 'ast' } });
  };
  const addLocal = (from: string, target: TsSymbol) => {
    const to = symId(ctx.path, target.name);
    if (to === from) return;
    const kind = kindForLocal(target);
    const key = edgeKey(from, kind, to);
    if (!edges.has(key)) edges.set(key, { key, from, to, kind, meta: { source: 'ast' } });
  };

  const visit = (n: ts.Node, owner: string): void => {
    // `ns.member` on a namespace import: one ref to the member, not to the namespace.
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
      const b = imports.get(n.expression.text);
      if (b?.targetName === '*' && !inTypePosition(n)) {
        addRef(owner, { targetPath: b.targetPath, targetName: n.name.text }, n.name.text);
        return;
      }
    }
    if (ts.isIdentifier(n) && isValueReference(n)) {
      const b = imports.get(n.text);
      if (b && b.targetName !== '*') addRef(owner, b, n.text);
      else if (!b) {
        const local = localSyms.get(n.text);
        if (local) addLocal(owner, local);
      }
    }
    ts.forEachChild(n, (c) => visit(c, owner));
  };

  const ownerOf = (name: string | undefined): string => (name && localSyms.has(name) ? symId(ctx.path, name) : ctx.ownerDefault);

  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) || ts.isImportEqualsDeclaration(s)) continue;
    if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) continue;
    if (ts.isFunctionDeclaration(s)) {
      visit(s, ownerOf(s.name?.text ?? 'default'));
    } else if (ts.isClassDeclaration(s)) {
      const cls = s.name?.text;
      for (const m of s.members) {
        const mName = m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : undefined;
        const methodId = cls && mName ? symId(ctx.path, `${cls}.${mName}`) : undefined;
        const isMethod = methodId && ctx.symbols.some((x) => x.kind === 'method' && x.name === `${cls}.${mName}`);
        visit(m, isMethod ? methodId : ownerOf(cls));
      }
      for (const h of s.heritageClauses ?? []) visit(h, ownerOf(cls));
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        const name = ts.isIdentifier(d.name) ? d.name.text : undefined;
        if (d.initializer) visit(d.initializer, ownerOf(name));
      }
    } else if (ts.isExportAssignment(s)) {
      visit(s.expression, ownerOf('default'));
    } else {
      visit(s, ctx.ownerDefault);
    }
  }
  return { refs: [...refs.values()], edges: [...edges.values()] };
}

/**
 * Imported functions and values used only in a template (`{{ formatPrice(x) }}`). Component tags are handled by
 * 046, so names written as tags (`<BaseButton`) and imports of .vue files are skipped.
 */
export function templateValueRefs(templateSource: string, imports: RawImport[], resolve: Resolver, path: string, owner: string): SymbolRef[] {
  const out: SymbolRef[] = [];
  for (const [local, b] of localImportBindings(imports, resolve, path)) {
    if (b.targetPath.endsWith('.vue') || b.targetName === '*') continue;
    const re = new RegExp(`(?<![<\\w$./-])${local.replace(/[$]/g, '\\$')}\\b`);
    if (re.test(templateSource)) out.push({ from: owner, kind: kindForName(local), targetPath: b.targetPath, targetName: b.targetName, meta: { source: 'ast' } });
  }
  return out;
}
