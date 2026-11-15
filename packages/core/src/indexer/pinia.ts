// PROMPTS 047: Pinia stores: `export const useXStore = defineStore(…)` in both styles.
//   options: defineStore('id', { state, getters, actions })  or  defineStore({ id, state, getters, actions })
//   setup:   defineStore('id', () => { …; return { … } })  (returned keys classified by their local declaration:
//            computed → getter; function / arrow → action; ref, reactive, useX(…) and the rest → state)

import ts from 'typescript';
import type { LineRange } from '../types.js';
import { keyName, lineOf, objectKeys, returnedObject, unwrap } from './ts-parse.js';

export interface PiniaStore {
  name: string; // the exported const, e.g. useOrderStore
  id: string | null; // store id, e.g. 'order'
  style: 'setup' | 'options';
  state: string[];
  getters: string[];
  actions: string[];
  /** Setup store whose returned members can't be read statically (e.g. `return state` built in a loop). */
  dynamic?: true;
  range: LineRange;
}

type Role = 'state' | 'getter' | 'action';

function roleOf(init: ts.Expression | undefined): Role {
  if (!init) return 'state';
  const e = unwrap(init);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return 'action';
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'computed') return 'getter';
  return 'state';
}

function readSetupStore(fn: ts.ArrowFunction | ts.FunctionExpression): { state: string[]; getters: string[]; actions: string[]; dynamic?: true } {
  const roles = new Map<string, Role>();
  if (ts.isBlock(fn.body)) {
    for (const s of fn.body.statements) {
      if (ts.isFunctionDeclaration(s) && s.name) roles.set(s.name.text, 'action');
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) roles.set(d.name.text, roleOf(d.initializer));
          else if (ts.isObjectBindingPattern(d.name)) {
            // const { a, b } = storeToRefs(other) / toRefs(x): treat as state
            for (const el of d.name.elements) if (ts.isIdentifier(el.name)) roles.set(el.name.text, 'state');
          }
        }
      }
    }
  }
  const out = { state: [] as string[], getters: [] as string[], actions: [] as string[] };
  const obj = returnedObject(fn.body);
  if (!obj) return { ...out, dynamic: true };
  for (const p of obj.properties) {
    let key: string | undefined;
    let role: Role = 'state';
    if (ts.isShorthandPropertyAssignment(p)) {
      key = p.name.text;
      role = roles.get(key) ?? 'state';
    } else if (ts.isPropertyAssignment(p)) {
      key = keyName(p.name);
      const v = unwrap(p.initializer);
      role = ts.isIdentifier(v) ? (roles.get(v.text) ?? 'state') : roleOf(v);
    } else if (ts.isMethodDeclaration(p)) {
      key = keyName(p.name);
      role = 'action';
    }
    if (!key) continue;
    (role === 'getter' ? out.getters : role === 'action' ? out.actions : out.state).push(key);
  }
  return out;
}

function readOptionsStore(o: ts.ObjectLiteralExpression): { id: string | null; state: string[]; getters: string[]; actions: string[] } {
  const out = { id: null as string | null, state: [] as string[], getters: [] as string[], actions: [] as string[] };
  for (const p of o.properties) {
    const key = keyName(p.name);
    if (key === 'state') {
      // state: () => ({…}) | state: function () {…} | state() {…}
      const v = ts.isPropertyAssignment(p) ? unwrap(p.initializer) : undefined;
      const body = v && (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) ? v.body : ts.isMethodDeclaration(p) ? p.body : undefined;
      const obj = body ? returnedObject(body) : undefined;
      if (obj) out.state.push(...objectKeys(obj));
    } else if ((key === 'getters' || key === 'actions') && ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer)) {
      out[key].push(...objectKeys(p.initializer));
    } else if (key === 'id' && ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer)) {
      out.id = p.initializer.text;
    }
  }
  return out;
}

export function extractPiniaStores(sf: ts.SourceFile, opts: { lineOffset?: number } = {}): PiniaStore[] {
  const offset = opts.lineOffset ?? 0;
  const stores: PiniaStore[] = [];
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const call = unwrap(d.initializer);
      if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'defineStore') continue;
      const [a0, a1] = call.arguments;
      const range = { startLine: lineOf(sf, s.getStart(sf)) + offset, endLine: lineOf(sf, s.end) + offset };
      const idFromArg = a0 && ts.isStringLiteral(a0) ? a0.text : null;
      const second = a1 ? unwrap(a1) : undefined;
      if (second && (ts.isArrowFunction(second) || ts.isFunctionExpression(second))) {
        stores.push({ name: d.name.text, id: idFromArg, style: 'setup', ...readSetupStore(second), range });
        continue;
      }
      const optionsObj = second && ts.isObjectLiteralExpression(second) ? second : a0 && ts.isObjectLiteralExpression(a0) ? a0 : undefined;
      const o = optionsObj ? readOptionsStore(optionsObj) : { id: null, state: [], getters: [], actions: [] };
      stores.push({ name: d.name.text, id: idFromArg ?? o.id, style: 'options', state: o.state, getters: o.getters, actions: o.actions, range });
    }
  }
  return stores;
}
