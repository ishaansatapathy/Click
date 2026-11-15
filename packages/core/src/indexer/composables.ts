// PROMPTS 048: composables: exported `use[A-Z]…` functions that are not Pinia stores, with the keys of the
// object they return (`meta.returns`) when it is a literal. Built on the symbols from 042.

import ts from 'typescript';
import type { LineRange } from '../types.js';
import { objectKeys, returnedObject, unwrap } from './ts-parse.js';
import type { TsSymbol } from './ts-symbols.js';

export interface Composable {
  name: string;
  returns: string[];
  range: LineRange;
}

export const COMPOSABLE_NAME = /^use[A-Z0-9]/;

export function isComposableSymbol(s: TsSymbol): boolean {
  return s.exported && s.kind === 'function' && COMPOSABLE_NAME.test(s.name);
}

/** The function body behind a top-level symbol name (function declaration or const arrow/function). */
function functionBody(sf: ts.SourceFile, name: string): ts.ConciseBody | undefined {
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name?.text === name && s.body) return s.body;
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== name || !d.initializer) continue;
        const init = unwrap(d.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init.body;
      }
    }
  }
  return undefined;
}

export function extractComposables(sf: ts.SourceFile, symbols: TsSymbol[]): Composable[] {
  return symbols.filter(isComposableSymbol).map((s) => {
    const body = functionBody(sf, s.name);
    const obj = body ? returnedObject(body) : undefined;
    return { name: s.name, returns: obj ? objectKeys(obj) : [], range: s.range };
  });
}
