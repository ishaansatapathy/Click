import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sha1 } from '../util/hash.js';
import { classifyFile, discover, isCandidate, normaliseContent } from './discover.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');

const EXPECTED: Array<[string, string]> = [
  ['components.d.ts', 'generated'],
  ['src/App.vue', 'src'],
  ['src/components/BaseButton.vue', 'src'],
  ['src/components/CartItem.vue', 'src'],
  ['src/components/CheckoutButton.vue', 'src'],
  ['src/components/OrderSummary.vue', 'src'],
  ['src/components/index.ts', 'src'],
  ['src/composables/useCartTotals.ts', 'src'],
  ['src/composables/useFormat.ts', 'src'],
  ['src/composables/useSubmit.ts', 'src'],
  ['src/generated/api.gen.ts', 'generated'],
  ['src/main.ts', 'src'],
  ['src/router/index.ts', 'src'],
  ['src/stores/cart.ts', 'src'],
  ['src/stores/order.ts', 'src'],
  ['src/types/order.ts', 'src'],
  ['src/utils/money.ts', 'src'],
  ['src/views/CheckoutView.vue', 'src'],
  ['src/views/HomeView.vue', 'src'],
  ['src/views/OrderDetailView.vue', 'src'],
  ['src/views/OrdersView.vue', 'src'],
  ['tests/checkout.spec.ts', 'test'],
  ['vite.config.ts', 'config'],
];

const temps: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'click-discover-'));
  temps.push(d);
  return d;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});
function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}
function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

describe('classifyFile / isCandidate (SPEC §5.1)', () => {
  it.each([
    ['src/a.ts', 'src'],
    ['src/a.spec.ts', 'test'],
    ['src/a.test.tsx', 'test'],
    ['tests/x.ts', 'test'],
    ['src/__tests__/x.ts', 'test'],
    ['dist/app.js', 'generated'],
    ['src/api.gen.ts', 'generated'],
    ['types/auto-imports.d.ts', 'generated'],
    ['vite.config.ts', 'config'],
    ['eslint.config.mjs', 'config'],
  ])('%s → %s', (p, cls) => expect(classifyFile(p)).toBe(cls));

  it('keeps source extensions and auto-import maps, drops other .d.ts and non-source files', () => {
    expect(['a.vue', 'a.ts', 'a.tsx', 'a.js', 'a.mjs', 'components.d.ts', 'x/auto-imports.d.ts'].every(isCandidate)).toBe(true);
    expect(['env.d.ts', 'a.json', 'a.css', 'a.md', 'a.cjs'].some(isCandidate)).toBe(false);
  });
});

describe('discover on the fixture repo', () => {
  it('finds exactly the source files, sorted and classified (git mode)', async () => {
    const r = await discover(FIXTURE);
    expect(r.mode).toBe('git');
    expect(r.files.map((f) => [f.path, f.class])).toEqual(EXPECTED);
    expect(r.skipped).toEqual([]);
    // allPaths lists every repo file (configs, .d.ts, json…), sorted; files are its indexable subset.
    expect(r.allPaths).toEqual(expect.arrayContaining(['package.json', 'tsconfig.json', 'src/env.d.ts', 'src/main.ts']));
    expect([...r.allPaths].sort()).toEqual(r.allPaths);
    expect(r.files.every((f) => r.allPaths.includes(f.path))).toBe(true);
  });

  it('gives the same answer with the fallback walker', async () => {
    const r = await discover(FIXTURE, { forceWalk: true });
    expect(r.mode).toBe('walk');
    expect(r.files.map((f) => [f.path, f.class])).toEqual(EXPECTED);
  });

  it('hashes normalised content and is deterministic', async () => {
    const [a, b] = await Promise.all([discover(FIXTURE), discover(FIXTURE)]);
    expect(a).toEqual(b);
    for (const f of a.files) {
      expect(f.content).not.toContain('\r');
      expect(f.hash).toBe(sha1(f.content));
    }
  });
});

describe('discover edge cases', () => {
  it('git mode: includes untracked, excludes ignored, reports deleted-but-tracked as missing, keeps unicode names', async () => {
    const root = temp();
    git(root, 'init', '-q');
    git(root, 'config', 'core.autocrlf', 'false');
    put(root, '.gitignore', 'ignored.ts\n');
    put(root, 'tracked.ts', 'export const a = 1;\n');
    put(root, 'gone.ts', 'export const g = 1;\n');
    put(root, 'src/cafè.ts', 'export const c = 1;\n');
    git(root, 'add', '-A');
    git(root, '-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-q', '-m', 'init');
    put(root, 'untracked.ts', 'export const u = 1;\n');
    put(root, 'ignored.ts', 'export const i = 1;\n');
    unlinkSync(join(root, 'gone.ts'));

    const r = await discover(root);
    expect(r.mode).toBe('git');
    expect(r.files.map((f) => f.path)).toEqual(['src/cafè.ts', 'tracked.ts', 'untracked.ts']);
    expect(r.skipped).toEqual([{ path: 'gone.ts', reason: 'missing' }]);
  });

  it('walk mode: honours root and nested .gitignore files, skips node_modules and .git', async () => {
    const root = temp();
    cpSync(FIXTURE, root, { recursive: true });
    put(root, '.gitignore', 'ignored/\n');
    put(root, 'ignored/secret.ts', 'x');
    put(root, 'src/.gitignore', '*.local.ts\n');
    put(root, 'src/dev.local.ts', 'x');
    put(root, 'node_modules/pkg/index.js', 'x');
    put(root, '.git/hooks/pre-commit.js', 'x');

    const r = await discover(root, { forceWalk: true });
    expect(r.files.map((f) => [f.path, f.class])).toEqual(EXPECTED);
  });

  it('normalises BOM and CRLF before hashing', async () => {
    const root = temp();
    put(root, 'crlf.ts', '﻿const a = 1;\r\nconst b = 2;\r\n');
    put(root, 'lf.ts', 'const a = 1;\nconst b = 2;\n');
    const r = await discover(root, { forceWalk: true });
    const [crlf, lf] = r.files;
    expect(crlf?.content).toBe('const a = 1;\nconst b = 2;\n');
    expect(crlf?.hash).toBe(lf?.hash);
    expect(normaliseContent('a\rb')).toBe('a\nb');
  });

  it('skips files above maxBytes', async () => {
    const root = temp();
    put(root, 'big.js', 'x'.repeat(500));
    put(root, 'small.ts', 'export {}\n');
    const r = await discover(root, { forceWalk: true, maxBytes: 100 });
    expect(r.files.map((f) => f.path)).toEqual(['small.ts']);
    expect(r.skipped).toEqual([{ path: 'big.js', reason: 'too-large' }]);
  });
});
