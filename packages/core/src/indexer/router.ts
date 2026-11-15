// PROMPTS 050: Vue Router routes → `route` nodes + `routes_to` edges.
// Two steps, so per-file extraction stays pure and cacheable by content hash:
//   1. extractRoutes(sf): the raw route tree of one file. A route table is an array literal of objects with a
//      `path`, found as a variable initializer or a `routes:` property (children arrays are read recursively).
//      Paths may be string literals, same-file consts, or imported consts (`path: REDIRECT_PATH`).
//      Components may be static imports, `() => import('…')`, `defineAsyncComponent(() => import('…'))`, or a
//      local lazy const (`const Layouts = () => import('@/layouts/index.vue')`).
//   2. finalizeRoutes(defs, …): joins nested paths, resolves imported path consts through a lookup (link stage,
//      which knows every file's symbols), and produces nodes + SymbolRefs.

import ts from 'typescript';
import type { SymbolRef } from '../contracts.js';
import type { GraphNode, LineRange } from '../types.js';
import { routeId } from '../util/ids.js';
import { countTokens } from '../util/tokens.js';
import type { Resolver } from './resolve.js';
import type { RawImport } from './ts-imports.js';
import { keyName, lineOf, stringValue, unwrap } from './ts-parse.js';
import type { ComponentTarget } from './vue-template.js';

export type PathExpr =
  | { kind: 'literal'; value: string }
  | { kind: 'ref'; local: string; targetPath: string; exportName: string } // imported const
  | { kind: 'unknown'; text: string };

export interface RouteDef {
  path: PathExpr;
  name?: string;
  range: LineRange;
  component: ComponentTarget | null;
  lazy: boolean;
  redirect?: string;
  children: RouteDef[];
}

export interface RouteCtx {
  path: string;
  imports: RawImport[];
  resolve: Resolver;
  lineOffset?: number;
}

const prop = (o: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined => {
  for (const p of o.properties) if (ts.isPropertyAssignment(p) && keyName(p.name) === key) return p.initializer;
  return undefined;
};

/** `() => import('x')`, `function () { return import('x') }`, `defineAsyncComponent(() => import('x'))` → 'x'. */
function lazyImportSpec(e: ts.Expression): string | undefined {
  const x = unwrap(e);
  if (ts.isCallExpression(x) && x.expression.kind === ts.SyntaxKind.ImportKeyword) return stringValue(x.arguments[0]);
  if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'defineAsyncComponent' && x.arguments[0]) return lazyImportSpec(x.arguments[0]);
  if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) {
    if (!ts.isBlock(x.body)) return lazyImportSpec(x.body);
    for (const s of x.body.statements) if (ts.isReturnStatement(s) && s.expression) return lazyImportSpec(s.expression);
  }
  return undefined;
}

function isRouteObject(e: ts.Expression): e is ts.ObjectLiteralExpression {
  return ts.isObjectLiteralExpression(e) && prop(e, 'path') !== undefined;
}

function isRouteTable(a: ts.ArrayLiteralExpression): boolean {
  return a.elements.some((el) => isRouteObject(unwrap(el as ts.Expression)));
}

export function extractRoutes(sf: ts.SourceFile, ctx: RouteCtx): RouteDef[] {
  const offset = ctx.lineOffset ?? 0;
  // Same-file string consts and lazy component consts.
  const localStrings = new Map<string, string>();
  const localLazy = new Map<string, string>();
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const v = stringValue(d.initializer);
      if (v !== undefined) localStrings.set(d.name.text, v);
      const lazy = lazyImportSpec(d.initializer);
      if (lazy) localLazy.set(d.name.text, lazy);
    }
  }
  // Imported bindings: for components and for path consts.
  const imported = new Map<string, { targetPath: string; exportName: string }>();
  for (const imp of ctx.imports) {
    if (imp.kind !== 'static') continue;
    const r = ctx.resolve(imp.spec, ctx.path);
    if (r.kind !== 'local') continue;
    for (const n of imp.names) if (!n.typeOnly && n.imported !== '*') imported.set(n.local, { targetPath: r.path, exportName: n.imported });
  }

  const target = (spec: string): ComponentTarget | null => {
    const r = ctx.resolve(spec, ctx.path);
    return r.kind === 'local' ? { path: r.path, exportName: 'default' } : null;
  };

  const pathExpr = (e: ts.Expression | undefined): PathExpr => {
    if (!e) return { kind: 'unknown', text: '' };
    const lit = stringValue(e);
    if (lit !== undefined) return { kind: 'literal', value: lit };
    const x = unwrap(e);
    if (ts.isIdentifier(x)) {
      const local = localStrings.get(x.text);
      if (local !== undefined) return { kind: 'literal', value: local };
      const imp = imported.get(x.text);
      if (imp) return { kind: 'ref', local: x.text, ...imp };
    }
    return { kind: 'unknown', text: x.getText(sf) };
  };

  const readRoute = (o: ts.ObjectLiteralExpression): RouteDef => {
    const compExpr = prop(o, 'component') ?? (() => {
      const comps = prop(o, 'components');
      return comps && ts.isObjectLiteralExpression(unwrap(comps)) ? prop(unwrap(comps) as ts.ObjectLiteralExpression, 'default') : undefined;
    })();
    let component: ComponentTarget | null = null;
    let lazy = false;
    if (compExpr) {
      const spec = lazyImportSpec(compExpr);
      const x = unwrap(compExpr);
      if (spec) {
        component = target(spec);
        lazy = true;
      } else if (ts.isIdentifier(x)) {
        const lazySpec = localLazy.get(x.text);
        const imp = imported.get(x.text);
        if (lazySpec) {
          component = target(lazySpec);
          lazy = true;
        } else if (imp) component = { path: imp.targetPath, exportName: imp.exportName };
      }
    }
    const childrenExpr = prop(o, 'children');
    const childArr = childrenExpr ? unwrap(childrenExpr) : undefined;
    const children = childArr && ts.isArrayLiteralExpression(childArr) ? readTable(childArr) : [];
    const def: RouteDef = {
      path: pathExpr(prop(o, 'path')),
      range: { startLine: lineOf(sf, o.getStart(sf)) + offset, endLine: lineOf(sf, o.end) + offset },
      component,
      lazy,
      children,
    };
    const name = stringValue(prop(o, 'name'));
    if (name !== undefined) def.name = name;
    const redirect = stringValue(prop(o, 'redirect'));
    if (redirect !== undefined) def.redirect = redirect;
    return def;
  };

  const readTable = (a: ts.ArrayLiteralExpression): RouteDef[] =>
    a.elements.map((el) => unwrap(el as ts.Expression)).filter(isRouteObject).map(readRoute);

  const tables: RouteDef[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isArrayLiteralExpression(n) && isRouteTable(n)) {
      const parent = n.parent;
      const viaVar = parent && ts.isVariableDeclaration(parent);
      const viaRoutesProp = parent && ts.isPropertyAssignment(parent) && keyName(parent.name) === 'routes';
      const viaCast = parent && (ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) && parent.parent && ts.isVariableDeclaration(parent.parent);
      if (viaVar || viaRoutesProp || viaCast) {
        tables.push(...readTable(n));
        return; // children are read by readRoute
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return tables;
}

/** Join a child path onto its parent the way Vue Router does: absolute child wins, '' means the parent itself. */
export function joinRoutePath(parent: string, child: string): string {
  if (child.startsWith('/')) return child;
  if (child === '') return parent || '/';
  const base = parent.replace(/\/+$/, '');
  return `${base}/${child}`;
}

export type ConstLookup = (targetPath: string, exportName: string) => string | undefined;

export interface FinalizedRoutes {
  nodes: GraphNode[];
  refs: SymbolRef[];
  unresolvedPaths: string[];
}

export function finalizeRoutes(defs: RouteDef[], filePath: string, fileHash: string, lookup: ConstLookup): FinalizedRoutes {
  const nodes = new Map<string, GraphNode>();
  const refs: SymbolRef[] = [];
  const unresolvedPaths: string[] = [];

  const segment = (p: PathExpr): string => {
    if (p.kind === 'literal') return p.value;
    if (p.kind === 'ref') {
      const v = lookup(p.targetPath, p.exportName);
      if (v !== undefined) return v;
      unresolvedPaths.push(p.local);
      return `{${p.local}}`;
    }
    unresolvedPaths.push(p.text);
    return `{${p.text}}`;
  };

  const walk = (list: RouteDef[], parentPath: string): void => {
    for (const d of list) {
      const fullPath = joinRoutePath(parentPath, segment(d.path));
      const id = routeId(fullPath);
      if (!nodes.has(id)) {
        const target = d.component ? ` → ${d.component.path}` : d.redirect ? ` → redirect ${d.redirect}` : '';
        const signature = `route ${fullPath}${d.name ? ` (${d.name})` : ''}${target}`;
        const meta: Record<string, unknown> = { fullPath, lazy: d.lazy };
        if (d.name) meta.routeName = d.name;
        if (d.redirect) meta.redirect = d.redirect;
        nodes.set(id, {
          id, kind: 'route', path: filePath, name: d.name ?? fullPath, range: d.range,
          signature, tokens: countTokens(signature), sigTokens: countTokens(signature), fileHash, meta,
        });
        if (d.component) refs.push({ from: id, kind: 'routes_to', targetPath: d.component.path, targetName: d.component.exportName, meta: { source: 'ast' } });
      }
      walk(d.children, fullPath);
    }
  };
  walk(defs, '');
  return { nodes: [...nodes.values()], refs, unresolvedPaths };
}
