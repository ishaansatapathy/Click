// PROMPTS 043: every module a file depends on. Static imports, re-exports (`export … from`) and dynamic
// `import('…')` (lazy routes). Resolution happens later (extract.ts) with the resolver from 041.
// Not handled (none in the bench repo; add when a repo needs it): `import.meta.glob`, `require()`, `import x = require()`.

import ts from 'typescript';
import type { ImportRef } from '../contracts.js';
import { lineOf } from './ts-parse.js';

export type ImportName = ImportRef['names'][number];

export interface RawImport {
  spec: string;
  kind: ImportRef['kind'];
  names: ImportName[]; // [] for side-effect and dynamic imports
  line: number; // 1-based, file-absolute when lineOffset is given
}

const specOf = (e: ts.Expression | undefined): string | undefined =>
  e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined;

export function extractTsImports(sf: ts.SourceFile, opts: { lineOffset?: number } = {}): RawImport[] {
  const offset = opts.lineOffset ?? 0;
  const out: RawImport[] = [];
  const line = (n: ts.Node) => lineOf(sf, n.getStart(sf)) + offset;

  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s)) {
      const spec = specOf(s.moduleSpecifier);
      if (spec === undefined) continue;
      const names: ImportName[] = [];
      const c = s.importClause;
      if (c) {
        const allType = c.isTypeOnly;
        if (c.name) names.push({ imported: 'default', local: c.name.text, typeOnly: allType });
        const nb = c.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) names.push({ imported: '*', local: nb.name.text, typeOnly: allType });
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) names.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text, typeOnly: allType || el.isTypeOnly });
        }
      }
      out.push({ spec, kind: 'static', names, line: line(s) });
    } else if (ts.isExportDeclaration(s) && s.moduleSpecifier) {
      const spec = specOf(s.moduleSpecifier);
      if (spec === undefined) continue;
      const allType = s.isTypeOnly;
      const ec = s.exportClause;
      let names: ImportName[];
      if (!ec) names = [{ imported: '*', local: '*', typeOnly: allType }];
      else if (ts.isNamespaceExport(ec)) names = [{ imported: '*', local: ec.name.text, typeOnly: allType }];
      else names = ec.elements.map((el) => ({ imported: (el.propertyName ?? el.name).text, local: el.name.text, typeOnly: allType || el.isTypeOnly }));
      out.push({ spec, kind: 'reexport', names, line: line(s) });
    }
  }

  // Dynamic imports can sit anywhere: inside route records, functions, components.
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const spec = specOf(n.arguments[0]);
      if (spec !== undefined) out.push({ spec, kind: 'dynamic', names: [], line: line(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  return out.sort((a, b) => a.line - b.line);
}
