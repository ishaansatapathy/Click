// SPEC §5.4: split a .vue file into its blocks with @vue/compiler-sfc, run the script blocks through the TS
// symbol and import extractors with file-absolute line numbers, and expose the template AST (for 046).
// Verified on compiler-sfc 3.5: a script block's loc.start.line is the line of its <script> tag and its content
// starts right after the tag, so content line k is file line (start + k - 1). Template AST locations are file-absolute.

import type { RootNode } from '@vue/compiler-core';
import { parse, type SFCDescriptor } from '@vue/compiler-sfc';
import type ts from 'typescript';
import type { LineRange } from '../types.js';
import { componentName } from '../util/ids.js';
import { extractTsImports, type RawImport } from './ts-imports.js';
import { parseTs } from './ts-parse.js';
import { extractTsSymbols, type TsSymbol } from './ts-symbols.js';

export type ScriptLang = 'ts' | 'tsx' | 'js' | 'jsx';

export interface SfcScript {
  setup: boolean;
  lang: ScriptLang;
  lineOffset: number;
  range: LineRange; // from the <script> tag to </script>
  sf: ts.SourceFile;
}

export interface SfcResult {
  componentName: string;
  range: LineRange; // the whole file: the component node's range
  scripts: SfcScript[];
  template: { ast: RootNode; source: string; range: LineRange } | null;
  styleBlocks: number;
  symbols: TsSymbol[]; // from every script block, file-absolute
  imports: RawImport[]; // from every script block, file-absolute
  errors: string[];
  descriptor: SFCDescriptor | null;
}

const LANGS: readonly ScriptLang[] = ['ts', 'tsx', 'js', 'jsx'];
const toLang = (lang: string | undefined): ScriptLang => (LANGS as readonly string[]).includes(lang ?? '') ? (lang as ScriptLang) : 'js';

export function lineCount(content: string): number {
  if (content === '') return 1;
  const n = content.split('\n').length;
  return content.endsWith('\n') ? n - 1 : n;
}

export function parseVueSfc(content: string, path: string): SfcResult {
  const base: SfcResult = {
    componentName: componentName(path),
    range: { startLine: 1, endLine: lineCount(content) },
    scripts: [],
    template: null,
    styleBlocks: 0,
    symbols: [],
    imports: [],
    errors: [],
    descriptor: null,
  };
  let descriptor: SFCDescriptor;
  try {
    const parsed = parse(content, { filename: path, sourceMap: false, ignoreEmpty: false });
    descriptor = parsed.descriptor;
    base.errors = parsed.errors.map((e) => (e instanceof Error ? e.message : String(e)));
  } catch (e) {
    return { ...base, errors: [e instanceof Error ? e.message : String(e)] };
  }
  base.descriptor = descriptor;

  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block) continue;
    const lang = toLang(block.lang);
    const lineOffset = block.loc.start.line - 1;
    const sf = parseTs(block.content, `${path}.${lang}`);
    base.scripts.push({ setup: Boolean(block.setup), lang, lineOffset, range: { startLine: block.loc.start.line, endLine: block.loc.end.line }, sf });
    base.symbols.push(...extractTsSymbols(sf, { lineOffset }));
    base.imports.push(...extractTsImports(sf, { lineOffset }));
  }
  base.symbols.sort((a, b) => a.range.startLine - b.range.startLine);
  base.imports.sort((a, b) => a.line - b.line);

  const t = descriptor.template;
  if (t?.ast) base.template = { ast: t.ast, source: t.content, range: { startLine: t.loc.start.line, endLine: t.loc.end.line } };
  base.styleBlocks = descriptor.styles.length;
  return base;
}
