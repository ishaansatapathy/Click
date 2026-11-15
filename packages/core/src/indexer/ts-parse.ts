// One parse per file, shared by symbol and import extraction (SPEC §5.3: createSourceFile only, no type checker).

import ts from 'typescript';

export function scriptKindFor(fileName: string): ts.ScriptKind {
  if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function parseTs(content: string, fileName = 'file.ts'): ts.SourceFile {
  return ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKindFor(fileName));
}

/** 1-based line of a position. */
export function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

/** Strip `( )`, `as T`, `satisfies T` and `!` around an expression. */
export function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
  return x;
}

export const keyName = (n: ts.PropertyName | undefined): string | undefined =>
  n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) ? n.text : undefined;

/** Keys of an object literal: shorthand, `key: value`, methods and getters. Spreads are skipped. */
export function objectKeys(o: ts.ObjectLiteralExpression): string[] {
  const out: string[] = [];
  for (const p of o.properties) {
    if (ts.isShorthandPropertyAssignment(p)) out.push(p.name.text);
    else if (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p)) {
      const k = keyName(p.name);
      if (k) out.push(k);
    }
  }
  return out;
}

/** The object a function body returns: `() => ({…})` or the last top-level `return {…}` of a block. */
export function returnedObject(body: ts.ConciseBody): ts.ObjectLiteralExpression | undefined {
  if (!ts.isBlock(body)) {
    const e = unwrap(body);
    return ts.isObjectLiteralExpression(e) ? e : undefined;
  }
  for (let i = body.statements.length - 1; i >= 0; i--) {
    const s = body.statements[i]!;
    if (ts.isReturnStatement(s) && s.expression) {
      const e = unwrap(s.expression);
      return ts.isObjectLiteralExpression(e) ? e : undefined;
    }
  }
  return undefined;
}

/** String value of a literal expression (`'x'`, `` `x` ``), or undefined. */
export function stringValue(e: ts.Expression | undefined): string | undefined {
  if (!e) return undefined;
  const x = unwrap(e);
  return ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) ? x.text : undefined;
}
