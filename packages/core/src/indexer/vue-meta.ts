// PROMPTS 045: a component's public surface: props, emits, slots, expose, v-model, name.
// Read straight from the TS AST of the macros (defineProps/defineEmits/defineSlots/defineModel/defineExpose/
// defineOptions) and from Options API objects, plus <slot> elements and $emit calls in the template.
// Deliberately NOT compileScript: it resolves imported prop types from disk and throws when it can't;
// the AST read is faster, never throws, and records unresolvable prop types by name (propsType).

import { NodeTypes, type RootNode, type TemplateChildNode } from '@vue/compiler-core';
import ts from 'typescript';
import type { SfcResult } from './vue-sfc.js';

export interface ComponentMeta {
  api: 'setup' | 'options' | 'none';
  name?: string;
  props: string[];
  emits: string[];
  slots: string[];
  exposed: string[];
  models: string[];
  /** Prop type names we could not expand (e.g. imported interfaces). */
  propsType?: string;
}

class Collector {
  readonly props: string[] = [];
  readonly emits: string[] = [];
  readonly slots: string[] = [];
  readonly exposed: string[] = [];
  readonly models: string[] = [];
  propsType: string[] = [];
  name: string | undefined;
  add(list: string[], ...names: string[]): void {
    for (const n of names) if (n && !list.includes(n)) list.push(n);
  }
}

const textOfName = (n: ts.PropertyName | ts.BindingName | undefined): string | undefined =>
  n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) ? n.text : undefined;

function stringLiterals(e: ts.Expression): string[] {
  if (!ts.isArrayLiteralExpression(e)) return [];
  return e.elements.filter((x): x is ts.StringLiteral => ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)).map((x) => x.text);
}

function objectKeys(e: ts.Expression): string[] {
  if (!ts.isObjectLiteralExpression(e)) return [];
  const out: string[] = [];
  for (const p of e.properties) {
    if (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) {
      const k = textOfName(p.name);
      if (k) out.push(k);
    } else if (ts.isShorthandPropertyAssignment(p)) out.push(p.name.text);
  }
  return out;
}

/** Names from an array literal or the keys of an object literal (both runtime declaration styles). */
const runtimeNames = (e: ts.Expression | undefined): string[] => (e ? [...stringLiterals(e), ...objectKeys(e)] : []);

/** Local interfaces and type aliases of a script block, for expanding `defineProps<Props>()`. */
function localTypes(sf: ts.SourceFile): Map<string, ts.Node> {
  const m = new Map<string, ts.Node>();
  for (const s of sf.statements) if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) m.set(s.name.text, s);
  return m;
}

/** Member names of a type literal / local interface / intersection; unresolved references are reported. */
function typeMembers(node: ts.TypeNode, types: Map<string, ts.Node>, unresolved: string[], depth = 0): string[] {
  if (depth > 5) return [];
  if (ts.isTypeLiteralNode(node)) return node.members.map((m) => textOfName(m.name)).filter((x): x is string => Boolean(x));
  if (ts.isIntersectionTypeNode(node)) return node.types.flatMap((t) => typeMembers(t, types, unresolved, depth + 1));
  if (ts.isParenthesizedTypeNode(node)) return typeMembers(node.type, types, unresolved, depth + 1);
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const decl = types.get(node.typeName.text);
    if (decl && ts.isInterfaceDeclaration(decl)) {
      const own = decl.members.map((m) => textOfName(m.name)).filter((x): x is string => Boolean(x));
      const inherited = (decl.heritageClauses ?? []).flatMap((h) => h.types.map((t) => t.expression.getText()));
      for (const i of inherited) if (!types.has(i)) unresolved.push(i);
      return [...own, ...inherited.flatMap((i) => (types.has(i) ? typeMembers(ts.factory.createTypeReferenceNode(i), types, unresolved, depth + 1) : []))];
    }
    if (decl && ts.isTypeAliasDeclaration(decl)) return typeMembers(decl.type, types, unresolved, depth + 1);
    unresolved.push(node.typeName.text);
  }
  return [];
}

/** Event names from `defineEmits<…>()`: call signatures `(e: 'a' | 'b', …)` or 3.3 named tuples `{ change: [id: number] }`. */
function emitTypeNames(node: ts.TypeNode): string[] {
  if (!ts.isTypeLiteralNode(node)) return [];
  const out: string[] = [];
  for (const m of node.members) {
    if (ts.isCallSignatureDeclaration(m)) {
      const t = m.parameters[0]?.type;
      const lits = t && ts.isUnionTypeNode(t) ? t.types : t ? [t] : [];
      for (const l of lits) if (ts.isLiteralTypeNode(l) && ts.isStringLiteral(l.literal)) out.push(l.literal.text);
    } else {
      const n = textOfName(m.name);
      if (n) out.push(n);
    }
  }
  return out;
}

function readSetupMacros(sf: ts.SourceFile, c: Collector): void {
  const types = localTypes(sf);
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const typeArg = n.typeArguments?.[0];
      const arg0 = n.arguments[0];
      switch (n.expression.text) {
        case 'defineProps':
          if (typeArg) c.add(c.props, ...typeMembers(typeArg, types, c.propsType));
          c.add(c.props, ...runtimeNames(arg0));
          break;
        case 'defineEmits':
          if (typeArg) c.add(c.emits, ...emitTypeNames(typeArg));
          c.add(c.emits, ...runtimeNames(arg0));
          break;
        case 'defineSlots':
          if (typeArg && ts.isTypeLiteralNode(typeArg)) c.add(c.slots, ...typeArg.members.map((m) => textOfName(m.name) ?? '').filter(Boolean));
          break;
        case 'defineExpose':
          if (arg0) c.add(c.exposed, ...objectKeys(arg0));
          break;
        case 'defineModel': {
          const name = arg0 && ts.isStringLiteral(arg0) ? arg0.text : 'modelValue';
          c.add(c.models, name);
          c.add(c.props, name);
          c.add(c.emits, `update:${name}`);
          break;
        }
        case 'defineOptions':
          if (arg0 && ts.isObjectLiteralExpression(arg0)) readOptionsObject(arg0, c);
          break;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

function readOptionsObject(obj: ts.ObjectLiteralExpression, c: Collector): void {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = textOfName(p.name);
    const v = p.initializer;
    if (key === 'name' && ts.isStringLiteral(v)) c.name ??= v.text;
    else if (key === 'props') c.add(c.props, ...runtimeNames(v));
    else if (key === 'emits') c.add(c.emits, ...runtimeNames(v));
    else if (key === 'expose') c.add(c.exposed, ...stringLiterals(v));
  }
}

/** `export default { … }` or `export default defineComponent({ … })`. Returns true when one was found. */
function readOptionsApi(sf: ts.SourceFile, c: Collector): boolean {
  for (const s of sf.statements) {
    if (!ts.isExportAssignment(s) || s.isExportEquals) continue;
    let e: ts.Expression = s.expression;
    if (ts.isCallExpression(e) && e.arguments[0]) e = e.arguments[0];
    if (ts.isObjectLiteralExpression(e)) {
      readOptionsObject(e, c);
      return true;
    }
  }
  return false;
}

function readTemplate(ast: RootNode, source: string, c: Collector): void {
  const visit = (n: RootNode | TemplateChildNode): void => {
    if (n.type === NodeTypes.ELEMENT && n.tag === 'slot') {
      let name = 'default';
      for (const p of n.props) {
        if (p.type === NodeTypes.ATTRIBUTE && p.name === 'name' && p.value) name = p.value.content;
        else if (p.type === NodeTypes.DIRECTIVE && p.name === 'bind' && p.arg?.type === NodeTypes.SIMPLE_EXPRESSION && p.arg.content === 'name') name = '[dynamic]';
      }
      c.add(c.slots, name);
    }
    if ('children' in n && Array.isArray(n.children)) for (const ch of n.children as TemplateChildNode[]) visit(ch);
  };
  visit(ast);
  for (const m of source.matchAll(/\$emit\(\s*['"]([^'"]+)['"]/g)) c.add(c.emits, m[1]!);
}

export function extractVueMeta(sfc: SfcResult): ComponentMeta {
  const c = new Collector();
  const setup = sfc.scripts.find((s) => s.setup);
  const plain = sfc.scripts.find((s) => !s.setup);
  if (setup) readSetupMacros(setup.sf, c);
  const options = plain ? readOptionsApi(plain.sf, c) : false;
  if (sfc.template) readTemplate(sfc.template.ast, sfc.template.source, c);
  const meta: ComponentMeta = {
    api: setup ? 'setup' : options ? 'options' : 'none',
    props: c.props,
    emits: c.emits,
    slots: c.slots,
    exposed: c.exposed,
    models: c.models,
  };
  if (c.name) meta.name = c.name;
  if (c.propsType.length) meta.propsType = [...new Set(c.propsType)].join(' & ');
  return meta;
}
