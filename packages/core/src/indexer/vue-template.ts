// PROMPTS 046: which components a template uses, what it passes them, and which of their events it listens to.
// A tag resolves, in order, through: the SFC's own imports → global registrations (app.component) → the
// auto-import map (components.d.ts). Built-ins (RouterView, Transition, <component :is>…) and HTML are skipped.
// Edges are emitted as SymbolRefs for link.ts. Convention: an `emits_to` ref is recorded on the parent side
// (from = the parent component) and link.ts creates the edge child → parent.

import { NodeTypes, type ElementNode, type RootNode, type TemplateChildNode } from '@vue/compiler-core';
import ts from 'typescript';
import type { SymbolRef } from '../contracts.js';
import type { RawImport } from './ts-imports.js';
import { componentName } from '../util/ids.js';
import { packageName, type Resolver } from './resolve.js';
import type { SfcResult } from './vue-sfc.js';

export interface ComponentTarget {
  path: string; // repo file that exports the component
  exportName: string; // 'default' for a .vue file; a named export for barrels
}

export type TagResolution =
  | { kind: 'local'; target: ComponentTarget; via: 'import' | 'global' | 'auto' }
  | { kind: 'external'; pkg: string }
  | { kind: 'builtin' }
  | { kind: 'self' } // recursive use by its own file name (script setup allows it); no edge
  | { kind: 'unresolved' };

export interface TemplateUsage {
  tag: string; // as written
  name: string; // PascalCase
  line: number; // file-absolute
  props: string[]; // camelCased; includes v-model targets
  events: string[]; // camelCased listener names ('update:modelValue' keeps its colon)
  resolution: TagResolution;
}

export type GlobalComponents = ReadonlyMap<string, ComponentTarget | { pkg: string }>;

export interface TemplateCtx {
  path: string;
  resolve: Resolver;
  globals: GlobalComponents;
  autoImport: Readonly<Record<string, string>>; // name → root-relative path or package spec
}

const BUILTINS = new Set(['Component', 'Transition', 'TransitionGroup', 'KeepAlive', 'Teleport', 'Suspense', 'Slot', 'Template', 'RouterView', 'RouterLink']);
const NOT_PROPS = new Set(['key', 'ref', 'is', 'class', 'style', 'slot']);

export const camelize = (s: string): string => s.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
export const pascalTag = (tag: string): string => {
  const c = camelize(tag);
  return c.charAt(0).toUpperCase() + c.slice(1);
};

type Binding = { kind: 'local'; target: ComponentTarget } | { kind: 'external'; pkg: string };

/** Local names bound by the SFC's value imports, resolved to component targets. */
function importBindings(imports: RawImport[], ctx: TemplateCtx): Map<string, Binding> {
  const m = new Map<string, Binding>();
  for (const imp of imports) {
    if (imp.kind !== 'static') continue;
    const r = ctx.resolve(imp.spec, ctx.path);
    for (const n of imp.names) {
      if (n.typeOnly || n.imported === '*') continue;
      if (r.kind === 'local') m.set(n.local, { kind: 'local', target: { path: r.path, exportName: n.imported } });
      else if (r.kind === 'external') m.set(n.local, { kind: 'external', pkg: r.pkg });
    }
  }
  return m;
}

function resolveTag(tag: string, name: string, bindings: Map<string, Binding>, ctx: TemplateCtx): TagResolution {
  if (BUILTINS.has(name)) return { kind: 'builtin' };
  const b = bindings.get(name) ?? bindings.get(tag);
  if (b) return b.kind === 'local' ? { kind: 'local', target: b.target, via: 'import' } : b;
  const g = ctx.globals.get(name);
  if (g) return 'pkg' in g ? { kind: 'external', pkg: g.pkg } : { kind: 'local', target: g, via: 'global' };
  const auto = ctx.autoImport[name];
  if (auto !== undefined) {
    const r = ctx.resolve(`/${auto.replace(/^\.?\//, '')}`, ctx.path); // root-relative path?
    if (r.kind === 'local') return { kind: 'local', target: { path: r.path, exportName: 'default' }, via: 'auto' };
    return { kind: 'external', pkg: packageName(auto) ?? auto };
  }
  if (name === componentName(ctx.path)) return { kind: 'self' };
  return { kind: 'unresolved' };
}

function propsAndEvents(el: ElementNode): { props: string[]; events: string[] } {
  const props: string[] = [];
  const events: string[] = [];
  const add = (list: string[], v: string) => {
    if (!list.includes(v)) list.push(v);
  };
  for (const p of el.props) {
    if (p.type === NodeTypes.ATTRIBUTE) {
      if (!NOT_PROPS.has(p.name)) add(props, camelize(p.name));
      continue;
    }
    if (p.type !== NodeTypes.DIRECTIVE) continue;
    const arg = p.arg && p.arg.type === NodeTypes.SIMPLE_EXPRESSION && p.arg.isStatic ? p.arg.content : undefined;
    if (p.name === 'bind' && arg && !NOT_PROPS.has(arg)) add(props, camelize(arg));
    else if (p.name === 'on' && arg) add(events, camelize(arg));
    else if (p.name === 'model') {
      const target = arg ? camelize(arg) : 'modelValue';
      add(props, target);
      add(events, `update:${target}`);
    }
  }
  return { props, events };
}

export function extractTemplateUsages(sfc: SfcResult, ctx: TemplateCtx): TemplateUsage[] {
  if (!sfc.template) return [];
  const bindings = importBindings(sfc.imports, ctx);
  const out: TemplateUsage[] = [];
  const visit = (n: RootNode | TemplateChildNode): void => {
    if (n.type === NodeTypes.ELEMENT) {
      const tag = n.tag;
      const isComponentLike = /[A-Z]/.test(tag.charAt(0)) || tag.includes('-') || tag === 'component' || tag === 'slot' || tag === 'template';
      if (isComponentLike) {
        const name = pascalTag(tag);
        out.push({ tag, name, line: n.loc.start.line, ...propsAndEvents(n), resolution: resolveTag(tag, name, bindings, ctx) });
      }
    }
    if ('children' in n && Array.isArray(n.children)) for (const ch of n.children as TemplateChildNode[]) visit(ch);
  };
  visit(sfc.template.ast);
  return out;
}

/** One uses_component ref per distinct local target, plus passes_prop / emits_to refs carrying the union of names. */
export function templateRefs(componentId: string, usages: TemplateUsage[]): SymbolRef[] {
  const byTarget = new Map<string, { target: ComponentTarget; props: string[]; events: string[] }>();
  for (const u of usages) {
    if (u.resolution.kind !== 'local') continue;
    const t = u.resolution.target;
    const key = `${t.path}#${t.exportName}`;
    const acc = byTarget.get(key) ?? { target: t, props: [], events: [] };
    for (const p of u.props) if (!acc.props.includes(p)) acc.props.push(p);
    for (const e of u.events) if (!acc.events.includes(e)) acc.events.push(e);
    byTarget.set(key, acc);
  }
  const refs: SymbolRef[] = [];
  for (const { target, props, events } of byTarget.values()) {
    const base = { from: componentId, targetPath: target.path, targetName: target.exportName };
    refs.push({ ...base, kind: 'uses_component', meta: { source: 'ast' } });
    if (props.length) refs.push({ ...base, kind: 'passes_prop', meta: { source: 'ast', props } });
    if (events.length) refs.push({ ...base, kind: 'emits_to', meta: { source: 'ast', events } });
  }
  return refs;
}

/**
 * Global registrations in one TS file: `app.component('Name', Comp)` with a string-literal name and an imported
 * identifier. Dynamic forms (`app.component(key, component)` in a loop) are skipped. build.ts merges all files.
 */
export function findGlobalRegistrations(sf: ts.SourceFile, imports: RawImport[], resolve: Resolver, path: string): Map<string, ComponentTarget | { pkg: string }> {
  const bindings = importBindings(imports, { path, resolve, globals: new Map(), autoImport: {} });
  const out = new Map<string, ComponentTarget | { pkg: string }>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'component' &&
      n.arguments.length >= 2 &&
      ts.isStringLiteral(n.arguments[0]!) &&
      ts.isIdentifier(n.arguments[1]!)
    ) {
      const b = bindings.get(n.arguments[1].text);
      if (b) out.set(pascalTag(n.arguments[0].text), b.kind === 'local' ? b.target : { pkg: b.pkg });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
