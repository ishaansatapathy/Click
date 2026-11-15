// PROMPTS 054: up to 10 project conventions the agent should follow, as time-stamped `Convention` records.
//   1. Detected facts with real counts (script-setup share, Pinia style, test stack, import alias, auto-imports).
//   2. Short imperative rules quoted from CLAUDE.md / AGENTS.md / CONTRIBUTING.md (any language: English and Chinese cues).
// Deterministic for a given input (the clock is injected). Facts come first, so they survive the cap of 10.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceFile } from '../contracts.js';
import type { Convention } from '../types.js';
import type { RepoProfile } from './profile.js';

export const MAX_CONVENTIONS = 10;
const MAX_RULES = 5;
const RULE_FILES = ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md'] as const;
const MAX_DOC_BYTES = 200_000;

// Imperative cues, English + Chinese. A bullet needs one to count as a rule.
const CUE = /\b(must|always|never|should|do not|don't|avoid|prefer|use|only)\b|必须|务必|不要|禁止|不得|应该|避免|优先|只能|请/i;

export interface ConventionInput {
  root: string;
  files: SourceFile[];
  profile: Pick<RepoProfile, 'viteAliases' | 'tsconfigPaths' | 'autoImport'>;
  now: Date;
}

const pct = (n: number, total: number): number => Math.round((100 * n) / total);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function detectedFacts(input: ConventionInput): { slug: string; text: string }[] {
  const { files, profile } = input;
  const out: { slug: string; text: string }[] = [];

  // 1. <script setup> share
  const vue = files.filter((f) => f.path.endsWith('.vue'));
  if (vue.length > 0) {
    const setup = vue.filter((f) => /<script[^>]*\bsetup\b/.test(f.content));
    const setupTs = setup.filter((f) => /<script[^>]*\blang=["']ts["']/.test(f.content));
    const ratio = setup.length / vue.length;
    out.push({
      slug: 'script-setup',
      text:
        ratio >= 0.5
          ? `Components use <script setup${setupTs.length === setup.length ? ' lang="ts"' : ''}> (${setup.length} of ${plural(vue.length, '.vue file')}, ${pct(setup.length, vue.length)}%).`
          : `Components mostly use the Options API; only ${setup.length} of ${plural(vue.length, '.vue file')} use <script setup>.`,
    });
  }

  // 2. Pinia store style
  let setupStores = 0;
  let optionsStores = 0;
  for (const f of files) {
    if (f.class !== 'src' || f.path.endsWith('.vue')) continue;
    for (const m of f.content.matchAll(/defineStore\(\s*(?:['"`][^'"`]*['"`]\s*,\s*)?(\(|function\b|async\b|\{)/g)) {
      if (m[1] === '{') optionsStores++;
      else setupStores++;
    }
  }
  const stores = setupStores + optionsStores;
  if (stores > 0) {
    out.push({
      slug: 'pinia-style',
      text:
        optionsStores === 0
          ? `Pinia stores use the setup style: defineStore('id', () => { … }) (${stores} of ${stores}).`
          : setupStores === 0
            ? `Pinia stores use the options style: defineStore('id', { state, getters, actions }) (${stores} of ${stores}).`
            : `Pinia stores are mixed: ${setupStores} setup-style, ${optionsStores} options-style.`,
    });
  }

  // 3. test stack
  const testFiles = files.filter((f) => f.class === 'test').length;
  if (testFiles > 0) out.push({ slug: 'test-stack', text: `Tests are written with the repo's test runner in ${plural(testFiles, 'test file')}; keep new tests next to the existing ones.` });

  // 4. import style
  const prefixes = [...Object.keys(profile.viteAliases), ...Object.keys(profile.tsconfigPaths).map((k) => k.replace(/\*$/, '').replace(/\/$/, ''))].filter(Boolean);
  const aliasPrefixes = [...new Set(prefixes)].sort((a, b) => b.length - a.length);
  let alias = 0;
  let relative = 0;
  for (const f of files) {
    if (f.class === 'generated') continue;
    for (const m of f.content.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1]!;
      if (spec.startsWith('./') || spec.startsWith('../')) relative++;
      else if (aliasPrefixes.some((p) => spec === p || spec.startsWith(`${p}/`))) alias++;
    }
  }
  if (alias + relative >= 5) {
    out.push({
      slug: 'import-alias',
      text:
        alias >= relative
          ? `Imports of repo files prefer the alias (${aliasPrefixes.join(', ')}): ${pct(alias, alias + relative)}% alias, ${pct(relative, alias + relative)}% relative.`
          : `Imports of repo files are mostly relative (${pct(relative, alias + relative)}%); the alias is used for ${pct(alias, alias + relative)}%.`,
    });
  }

  // 5. auto-imports
  const autoComponents = Object.keys(profile.autoImport.components).length;
  const autoApis = Object.keys(profile.autoImport.imports).length;
  if (autoComponents > 0) out.push({ slug: 'auto-components', text: `Components are auto-imported (${plural(autoComponents, 'component')}): use them in templates without an import.` });
  if (autoApis > 0) out.push({ slug: 'auto-imports', text: `APIs such as ref and computed are auto-imported (${plural(autoApis, 'name')}): do not import them manually.` });

  // 6. language mix
  const js = files.filter((f) => f.class === 'src' && /\.(js|mjs)$/.test(f.path)).length;
  const ts = files.filter((f) => f.class === 'src' && /\.tsx?$/.test(f.path)).length;
  if (ts > 0 && js > 0) out.push({ slug: 'language', text: `New code is TypeScript (${pct(ts, ts + js)}% of source files; ${plural(js, 'JavaScript file')} remain).` });
  return out;
}

/** Imperative bullet lines from a markdown doc, outside code fences, cleaned of markers. */
export function extractRules(markdown: string): string[] {
  const rules: string[] = [];
  let fenced = false;
  for (const raw of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) fenced = !fenced;
    if (fenced) continue;
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(raw);
    if (!m) continue;
    const text = m[1]!.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
    if (text.length < 8 || text.length > 180 || /^https?:\/\//.test(text)) continue;
    if (CUE.test(text) && !rules.includes(text)) rules.push(text);
  }
  return rules;
}

async function readDoc(root: string, name: string): Promise<string | null> {
  try {
    const text = await readFile(join(root, name), 'utf8');
    return text.length > MAX_DOC_BYTES ? text.slice(0, MAX_DOC_BYTES) : text;
  } catch {
    return null;
  }
}

export async function extractConventions(input: ConventionInput): Promise<Convention[]> {
  const validFrom = input.now.toISOString();
  const mk = (slug: string, text: string, source: string): Convention => ({ id: `conv:${slug}`, text, source, validFrom, validTo: null });

  const out: Convention[] = detectedFacts(input).map((f) => mk(`detected-${f.slug}`, f.text, 'detected'));
  let rules = 0;
  for (const name of RULE_FILES) {
    const doc = await readDoc(input.root, name);
    if (!doc) continue;
    const slugBase = name.toLowerCase().replace(/\.md$/, '');
    let n = 0;
    for (const rule of extractRules(doc)) {
      if (rules >= MAX_RULES || out.length >= MAX_CONVENTIONS) break;
      out.push(mk(`${slugBase}-${++n}`, rule, name));
      rules++;
    }
  }
  return out.slice(0, MAX_CONVENTIONS);
}
