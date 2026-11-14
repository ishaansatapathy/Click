import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';

import ts from 'typescript';

import { normPath } from '../util/ids.js';

export interface RepoProfile {
  root: string;
  tsconfigPaths: Record<string, string[]>;
  baseUrl: string | null;
  viteAliases: Record<string, string>;
  entryFile: string | null;
  routerFiles: string[];
  storeFiles: string[];
  testGlobs: string[];
  autoImport: { components: Record<string, string>; imports: Record<string, string> };
  counts: Record<string, number>;
}

const SOURCE_EXTENSIONS = new Set(['.vue', '.ts', '.tsx', '.js', '.mjs']);
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'coverage', '.output']);

export function profileRepo(root: string): RepoProfile {
  const absoluteRoot = resolve(root);
  const files = walk(absoluteRoot);
  const sourceFiles = files.filter((file) => SOURCE_EXTENSIONS.has(extname(file)) && !file.endsWith('.d.ts'));
  const tsconfigs = files.filter((file) => /^tsconfig.*\.json$/i.test(basename(file)));
  const viteConfigs = files.filter((file) => /^(vite|vitest)\.config\.(?:ts|js|mts|mjs)$/i.test(basename(file)));

  const tsconfig = parseTsconfigs(absoluteRoot, tsconfigs);
  const vite = parseViteConfigs(absoluteRoot, viteConfigs);
  const classified = classifySources(absoluteRoot, sourceFiles);
  const autoImport = parseDeclarationMaps(absoluteRoot, files.filter((file) => file.endsWith('.d.ts')));

  return {
    root: absoluteRoot,
    tsconfigPaths: tsconfig.paths,
    baseUrl: tsconfig.baseUrl,
    viteAliases: vite.aliases,
    entryFile: classified.entryFile,
    routerFiles: classified.routerFiles,
    storeFiles: classified.storeFiles,
    testGlobs: [...new Set(vite.testGlobs)].sort(),
    autoImport,
    counts: countExtensions(files),
  };
}

function parseTsconfigs(root: string, files: string[]): { paths: Record<string, string[]>; baseUrl: string | null } {
  const paths: Record<string, string[]> = {};
  let baseUrl: string | null = null;
  for (const file of files.sort()) {
    const parsed = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
    if (parsed.error || !isRecord(parsed.config)) continue;
    const options = isRecord(parsed.config.compilerOptions) ? parsed.config.compilerOptions : {};
    const configuredBase = typeof options.baseUrl === 'string' ? resolve(dirname(file), options.baseUrl) : dirname(file);
    if (baseUrl === null && typeof options.baseUrl === 'string') baseUrl = normPath(root, configuredBase);
    if (!isRecord(options.paths)) continue;
    for (const [key, value] of Object.entries(options.paths)) {
      if (!Array.isArray(value)) continue;
      paths[key] = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => normPath(root, resolve(configuredBase, item)));
    }
  }
  return { paths, baseUrl };
}

function parseViteConfigs(root: string, files: string[]): { aliases: Record<string, string>; testGlobs: string[] } {
  const aliases: Record<string, string> = {};
  const testGlobs: string[] = [];
  for (const file of files.sort()) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const bindings = collectBindings(source, dirname(file));
    visit(source, (node) => {
      if (!ts.isPropertyAssignment(node)) return;
      const name = propertyName(node.name);
      if (name === 'alias') Object.assign(aliases, parseAliases(root, dirname(file), node.initializer, bindings));
      if (name === 'include' && hasAncestorProperty(node, 'test')) {
        testGlobs.push(...stringArray(node.initializer));
      }
    });
  }
  return { aliases, testGlobs };
}

function parseAliases(
  root: string,
  configDir: string,
  node: ts.Expression,
  bindings: Map<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = propertyName(property.name);
      const target = evaluatePath(property.initializer, bindings);
      if (key && target) result[key] = normaliseTarget(root, configDir, target);
    }
  } else if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      if (!ts.isObjectLiteralExpression(element)) continue;
      const find = objectProperty(element, 'find');
      const replacement = objectProperty(element, 'replacement');
      const key = find && ts.isStringLiteralLike(find) ? find.text : null;
      const target = replacement ? evaluatePath(replacement, bindings) : null;
      if (key && target) result[key] = normaliseTarget(root, configDir, target);
    }
  }
  return result;
}

function classifySources(root: string, files: string[]): {
  entryFile: string | null; routerFiles: string[]; storeFiles: string[];
} {
  const entries: { path: string; score: number }[] = [];
  const routerFiles: string[] = [];
  const storeFiles: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const path = normPath(root, file);
    const script = extname(file) === '.vue' ? vueScripts(text) : text;
    const source = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true, scriptKind(file));
    let createApp = false;
    let mount = false;
    let createRouter = false;
    let defineStore = false;
    visit(source, (node) => {
      if (!ts.isCallExpression(node)) return;
      const called = callName(node.expression);
      createApp ||= called === 'createApp' || called === 'createSSRApp' || called === 'createVaporApp';
      mount ||= called === 'mount';
      createRouter ||= called === 'createRouter';
      defineStore ||= called === 'defineStore';
    });
    if (createRouter) routerFiles.push(path);
    if (defineStore && !/^(?:tests?|__tests__)\//.test(path) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) {
      storeFiles.push(path);
    }
    if (createApp || mount) {
      const score = (createApp ? 4 : 0) + (mount ? 2 : 0) + (/\/main\.[cm]?[jt]sx?$/.test(`/${path}`) ? 3 : 0)
        - (/^(?:tests?|docs|playground)\//.test(path) ? 4 : 0);
      entries.push({ path, score });
    }
  }
  entries.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return {
    entryFile: entries[0]?.path ?? null,
    routerFiles: routerFiles.sort(),
    storeFiles: storeFiles.sort(),
  };
}

function parseDeclarationMaps(root: string, files: string[]): RepoProfile['autoImport'] {
  const components: Record<string, string> = {};
  const imports: Record<string, string> = {};
  for (const file of files) {
    if (!/(?:components|auto-imports)\.d\.ts$/i.test(file)) continue;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    visit(source, (node) => {
      if (ts.isPropertySignature(node) && node.type) {
        const imported = importTypeSource(node.type);
        const name = propertyName(node.name);
        if (name && imported) components[name] = resolveImportMapTarget(root, file, imported);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.type) {
        const imported = importTypeSource(node.type);
        if (imported) imports[node.name.text] = resolveImportMapTarget(root, file, imported);
      }
    });
  }
  return { components: sortRecord(components), imports: sortRecord(imports) };
}

function collectBindings(source: ts.SourceFile, configDir: string): Map<string, string> {
  const bindings = new Map<string, string>([
    ['__configDir', configDir],
    ['__configFile', source.fileName],
    ['__dirname', configDir],
  ]);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const value = evaluatePath(declaration.initializer, bindings);
      if (value) bindings.set(declaration.name.text, value);
    }
  }
  return bindings;
}

function evaluatePath(node: ts.Expression, bindings: Map<string, string>): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) return bindings.get(node.text) ?? null;
  if (ts.isNewExpression(node) && callName(node.expression) === 'URL') {
    const part = node.arguments?.[0];
    return part && ts.isStringLiteralLike(part) ? resolve(bindings.get('__configDir')!, part.text) : null;
  }
  if (!ts.isCallExpression(node)) return null;
  const name = callName(node.expression);
  if (name === 'dirname') return dirname(evaluatePath(node.arguments[0]!, bindings) ?? bindings.get('__configDir')!);
  if (name === 'fileURLToPath') return evaluatePath(node.arguments[0]!, bindings) ?? bindings.get('__configFile')!;
  if (name === 'resolve') {
    const parts = node.arguments.map((argument) => evaluatePath(argument, bindings)).filter((v): v is string => !!v);
    return parts.length ? resolve(...parts) : null;
  }
  if (node.arguments[0] && ts.isNewExpression(node.arguments[0]) && callName(node.arguments[0].expression) === 'URL') {
    const part = node.arguments[0].arguments?.[0];
    return part && ts.isStringLiteralLike(part) ? resolve(bindings.get('__configDir')!, part.text) : null;
  }
  return null;
}

function walk(root: string): string[] {
  const files: string[] = [];
  const queue = [root];
  while (queue.length) {
    const directory = queue.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() || entry.isSymbolicLink() && statSync(path).isFile()) files.push(path);
    }
  }
  return files.sort();
}

function countExtensions(files: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of files) {
    const extension = extname(file).toLowerCase() || '<none>';
    counts[extension] = (counts[extension] ?? 0) + 1;
  }
  return sortRecord(counts);
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
}

function objectProperty(object: ts.ObjectLiteralExpression, key: string): ts.Expression | null {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property.name) === key) return property.initializer;
  }
  return null;
}

function hasAncestorProperty(node: ts.Node, key: string): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isPropertyAssignment(current) && propertyName(current.name) === key) return true;
    current = current.parent;
  }
  return false;
}

function stringArray(node: ts.Expression): string[] {
  return ts.isArrayLiteralExpression(node)
    ? node.elements.filter(ts.isStringLiteralLike).map((item) => item.text)
    : [];
}

function callName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function importTypeSource(node: ts.TypeNode): string | null {
  let result: string | null = null;
  visit(node, (child) => {
    if (result || !ts.isImportTypeNode(child) || !ts.isLiteralTypeNode(child.argument)) return;
    if (ts.isStringLiteralLike(child.argument.literal)) result = child.argument.literal.text;
  });
  return result;
}

function resolveImportMapTarget(root: string, file: string, target: string): string {
  return target.startsWith('.') ? normPath(root, resolve(dirname(file), target)) : target;
}

function normaliseTarget(root: string, configDir: string, target: string): string {
  if (target.startsWith('@')) return target;
  const absolute = isAbsolute(target) ? target : resolve(configDir, target);
  return absolute.startsWith(root) ? normPath(root, absolute) : target.replace(/\\/g, '/');
}

function vueScripts(text: string): string {
  return [...text.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).join('\n');
}

function scriptKind(file: string): ts.ScriptKind {
  return file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
