import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSourceFile } from '../indexer/discover.js';
import type { GraphNode } from '../types.js';
import { blankCjkComments } from '../util/comments.js';
import { BLANK_CJK_MARKER, BodyReader } from './bodies.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'click-blank-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
async function node(rel: string, startLine: number, endLine: number): Promise<Pick<GraphNode, 'id' | 'path' | 'range' | 'fileHash'>> {
  const f = await readSourceFile(root, rel);
  if ('reason' in f) throw new Error(f.reason);
  return { id: `sym:${rel}#x`, path: rel, range: { startLine, endLine }, fileHash: f.hash };
}

const SRC = ['// 登出', 'export function logout() {', '  reset() // 重置', '  return "你好"', '}'].join('\n') + '\n';

describe('blanking Chinese comments (opt-in, per repository)', () => {
  it('serves the code as it is when the repository has not asked for it', async () => {
    put('src/a.ts', SRC);
    const res = await new BodyReader(root, { honorBlankMarker: true }).read(await node('src/a.ts', 1, 5));
    expect(res).toEqual({ ok: true, text: SRC.trimEnd() });
  });

  it('ignores the marker unless the caller honours it: the benchmark and in-process callers always see the real code', async () => {
    put('src/a.ts', SRC);
    put(BLANK_CJK_MARKER, '');
    const res = await new BodyReader(root).read(await node('src/a.ts', 1, 5));
    expect(res).toEqual({ ok: true, text: SRC.trimEnd() });
  });

  it('blanks the comments, keeps strings, keeps every line where it is, and still matches the file hash', async () => {
    put('src/a.ts', SRC);
    put(BLANK_CJK_MARKER, '');
    const res = await new BodyReader(root, { honorBlankMarker: true }).read(await node('src/a.ts', 1, 5));
    expect(res).toEqual({ ok: true, text: ['//', 'export function logout() {', '  reset()', '  return "你好"', '}'].join('\n') });
  });

  it('follows the marker while the reader is running (added or removed later), not a cached copy', async () => {
    put('src/a.ts', SRC);
    const reader = new BodyReader(root, { honorBlankMarker: true });
    const n = await node('src/a.ts', 1, 1);
    expect(await reader.read(n)).toEqual({ ok: true, text: '// 登出' });
    put(BLANK_CJK_MARKER, '');
    expect(await reader.read(n)).toEqual({ ok: true, text: '//' });
    rmSync(join(root, BLANK_CJK_MARKER));
    expect(await reader.read(n)).toEqual({ ok: true, text: '// 登出' });
  });
});

describe('blankCjkComments', () => {
  it('blanks the text of Chinese comments in every style and keeps the line count', () => {
    const src = ['// 模拟用户变化', 'const a = 1 // 用刷新页面代替重新登录', '/** 一个说明 */', '/*', ' * 多行说明', ' */', '/* 开头说明', '   继续 */', '<!-- 模板注释 -->', 'const b = 2'].join('\n');
    const out = blankCjkComments(src);
    expect(out.split('\n')).toHaveLength(src.split('\n').length);
    expect(/[一-鿿]/.test(out)).toBe(false);
    expect(out).toContain('const a = 1');
    expect((out.match(/\/\*/g) ?? []).length).toBe((out.match(/\*\//g) ?? []).length);
  });

  it('leaves Chinese in strings and URLs, and English comments, alone', () => {
    const src = ['title: "来自楚门的世界",', "const url = 'https://example.com/路径' // ok", '// keep this'].join('\n');
    expect(blankCjkComments(src)).toBe(src);
  });
});
