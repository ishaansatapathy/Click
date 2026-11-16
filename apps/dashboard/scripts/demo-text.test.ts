import { describe, expect, it } from 'vitest';
import { blankCjkComments } from './demo-text.js';

const CJK = /[一-鿿]/;

describe('blankCjkComments', () => {
  it('blanks the text of Chinese comments, whatever the comment style, and keeps the line count', () => {
    const src = [
      '// 模拟用户变化',
      'const a = 1 // 用刷新页面代替重新登录',
      '/** 一个说明 */',
      '/*',
      ' * 多行说明',
      ' * 第二行',
      ' */',
      '/* 开头说明',
      '   继续 */',
      '<!-- 模板注释 -->',
      'const b = 2',
    ].join('\n');
    const out = blankCjkComments(src);
    expect(out.split('\n')).toHaveLength(src.split('\n').length);
    expect(CJK.test(out)).toBe(false);
    expect(out).toContain('const a = 1');
    expect(out).toContain('const b = 2');
    // the comments still open and close, so the file still parses
    expect((out.match(/\/\*/g) ?? []).length).toBe((out.match(/\*\//g) ?? []).length);
  });

  it('leaves Chinese inside strings and URLs alone: they are code, not comments', () => {
    const src = ['title: "来自楚门的世界",', "const url = 'https://example.com/路径' // ok", 'const t = `你好 // ${x}`'].join('\n');
    expect(blankCjkComments(src)).toBe(src);
  });

  it('leaves English comments untouched', () => {
    expect(blankCjkComments('// keep this\n/* and this */')).toBe('// keep this\n/* and this */');
  });
});
