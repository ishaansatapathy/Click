// PROMPTS 052: a test file becomes one `test` node, and everything it imports from the repo is "tested by" it.
// Convention (same as emits_to): the ref is recorded on this file's side (from = the test node) and link.ts creates
// the edge target → test, so "what tests cover useOrderStore" is an incoming-edge query.

import ts from 'typescript';
import { posix } from 'node:path';
import type { SymbolRef } from '../contracts.js';
import { symId } from '../util/ids.js';
import { isIndexedPath } from './discover.js';
import type { Resolver } from './resolve.js';
import type { RawImport } from './ts-imports.js';
import { stringValue } from './ts-parse.js';
import { capSignature } from './ts-symbols.js';

export interface TestFileInfo {
  nodeId: string;
  name: string; // basename with extension: sym:<path>#<name>
  describes: string[]; // first describe titles, for BM25 and signatures
  cases: number; // it() / test() calls
  signature: string;
  refs: SymbolRef[];
}

const CASE_FNS = new Set(['it', 'test']);

export function extractTestFile(sf: ts.SourceFile, path: string, imports: RawImport[], resolve: Resolver): TestFileInfo {
  const name = posix.basename(path);
  const nodeId = symId(path, name);
  const describes: string[] = [];
  let cases = 0;

  const calleeName = (e: ts.Expression): string | undefined => {
    if (ts.isIdentifier(e)) return e.text;
    // describe.only / it.skip / test.concurrent
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) return e.expression.text;
    return undefined;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = calleeName(n.expression);
      if (callee === 'describe') {
        const title = stringValue(n.arguments[0]);
        if (title !== undefined && !describes.includes(title)) describes.push(title);
      } else if (callee && CASE_FNS.has(callee) && n.arguments[0] && stringValue(n.arguments[0]) !== undefined) {
        cases++;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  const refs = new Map<string, SymbolRef>();
  for (const imp of imports) {
    if (imp.kind === 'reexport') continue;
    const r = resolve(imp.spec, path);
    if (r.kind !== 'local' || !isIndexedPath(r.path)) continue;
    const names = imp.names.filter((n) => !n.typeOnly);
    const targets = imp.names.length === 0 ? ['*'] : names.map((n) => n.imported);
    for (const targetName of targets) {
      const key = `${r.path}#${targetName}`;
      if (!refs.has(key)) refs.set(key, { from: nodeId, kind: 'tested_by', targetPath: r.path, targetName, meta: { source: 'ast' } });
    }
  }

  const titles = describes.slice(0, 3).map((d) => `"${d}"`).join(', ');
  const signature = capSignature(`test file ${name}${titles ? `: describe ${titles}` : ''} (${cases} case${cases === 1 ? '' : 's'})`);
  return { nodeId, name, describes, cases, signature, refs: [...refs.values()] };
}
