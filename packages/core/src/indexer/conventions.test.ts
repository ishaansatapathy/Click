import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_CONVENTIONS, extractConventions, extractRules } from './conventions.js';
import { discover } from './discover.js';
import { profileRepo } from './profile.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');
const NOW = new Date('2026-11-15T10:00:00.000Z');

describe('extractConventions on the fixture (PROMPTS 054)', () => {
  let out: Awaited<ReturnType<typeof extractConventions>>;
  beforeAll(async () => {
    const files = (await discover(FIXTURE)).files;
    out = await extractConventions({ root: FIXTURE, files, profile: profileRepo(FIXTURE), now: NOW });
  });
  const text = (slug: string) => out.find((c) => c.id === `conv:detected-${slug}`)?.text;

  it('detects facts with real counts', () => {
    expect(text('script-setup')).toBe('Components use <script setup lang="ts"> (7 of 9 .vue files, 78%).');
    expect(text('pinia-style')).toBe('Pinia stores are mixed: 1 setup-style, 1 options-style.');
    expect(text('test-stack')).toContain('1 test file');
    expect(text('import-alias')).toMatch(/prefer the alias \(@\): \d+% alias, \d+% relative\./);
    expect(text('auto-components')).toBe('Components are auto-imported (2 components): use them in templates without an import.');
    expect(text('auto-imports')).toBeUndefined(); // the fixture has no API auto-imports
  });

  it('records time-stamped, open-ended conventions with stable ids', () => {
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) expect(c).toMatchObject({ validFrom: NOW.toISOString(), validTo: null, source: 'detected' });
    expect(new Set(out.map((c) => c.id)).size).toBe(out.length);
  });

  it('is deterministic', async () => {
    const files = (await discover(FIXTURE)).files;
    const again = await extractConventions({ root: FIXTURE, files, profile: profileRepo(FIXTURE), now: NOW });
    expect(again).toEqual(out);
  });
});

describe('rules from agent docs', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'click-conv-'));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), [
      '# Rules', '- Always run `pnpm lint` before committing.', '- 不要添加未要求的功能', '- misc note about the weather', '',
      '```', '- never parsed because inside a fence', '```', '1. **Avoid** default exports in new files', '- [Prefer small PRs](https://x.dev/y)', '- ok',
    ].join('\n'));
    writeFileSync(join(root, 'CLAUDE.md'), Array.from({ length: 12 }, (_, i) => `- You must follow rule number ${i}`).join('\n'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('extractRules keeps imperative bullets in any language, skips fences, links-only and noise, and cleans markers', () => {
    expect(extractRules(readText(root, 'AGENTS.md'))).toEqual([
      'Always run pnpm lint before committing.',
      '不要添加未要求的功能',
      'Avoid default exports in new files',
      'Prefer small PRs',
    ]);
  });

  it('quotes rules with their source file, caps rules at 5 and everything at 10', async () => {
    const out = await extractConventions({ root, files: [], profile: { viteAliases: {}, tsconfigPaths: {}, autoImport: { components: {}, imports: {} } }, now: NOW });
    expect(out.length).toBeLessThanOrEqual(MAX_CONVENTIONS);
    expect(out.filter((c) => c.source !== 'detected')).toHaveLength(5);
    expect(out[0]).toMatchObject({ id: 'conv:claude-1', source: 'CLAUDE.md' }); // CLAUDE.md is read first
    expect(out.some((c) => c.id === 'conv:agents-1')).toBe(false); // the cap was reached on CLAUDE.md
  });

  it('missing docs and an empty repo give no conventions', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'click-conv-empty-'));
    try {
      expect(await extractConventions({ root: empty, files: [], profile: { viteAliases: {}, tsconfigPaths: {}, autoImport: { components: {}, imports: {} } }, now: NOW })).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

const readText = (root: string, name: string) => readFileSync(join(root, name), 'utf8');
