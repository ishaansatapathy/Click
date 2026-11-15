import { describe, expect, it } from 'vitest';
import {
  PathOutsideRootError,
  chunkId,
  componentName,
  convId,
  edgeKey,
  fileId,
  normPath,
  parseId,
  routeId,
  symId,
} from './ids.js';

describe('normPath', () => {
  it('normalises Windows absolute paths against a Windows root', () => {
    expect(normPath('C:\\repo', 'C:\\repo\\src\\a.ts')).toBe('src/a.ts');
    expect(normPath('C:\\repo\\', 'C:\\repo\\src\\a.ts')).toBe('src/a.ts');
  });
  it('matches the drive and folders case-insensitively but preserves the file case', () => {
    expect(normPath('c:\\Repo', 'C:\\repo\\src\\OrderSummary.vue')).toBe('src/OrderSummary.vue');
  });
  it('handles mixed slashes and a posix-style Windows root', () => {
    expect(normPath('C:/repo', 'C:\\repo/src\\stores/order.ts')).toBe('src/stores/order.ts');
  });
  it('handles relative inputs, ./ prefixes and trailing slashes', () => {
    expect(normPath('/r', './src/a.ts')).toBe('src/a.ts');
    expect(normPath('/r', 'src\\a.ts')).toBe('src/a.ts');
    expect(normPath('/r', 'src/components/')).toBe('src/components');
    expect(normPath('/r', 'src/./x/../a.ts')).toBe('src/a.ts');
  });
  it('maps the root itself to "."', () => {
    expect(normPath('/r', '/r')).toBe('.');
    expect(normPath('/r', '')).toBe('.');
  });
  it('throws on paths outside the root', () => {
    expect(() => normPath('/r', '../x.ts')).toThrow(PathOutsideRootError);
    expect(() => normPath('/r', 'src/../../x.ts')).toThrow(PathOutsideRootError);
    expect(() => normPath('/r', '/other/a.ts')).toThrow(PathOutsideRootError);
    expect(() => normPath('/r', '/rx/a.ts')).toThrow(PathOutsideRootError); // sibling sharing a prefix
    expect(() => normPath('C:\\repo', 'D:\\repo\\a.ts')).toThrow(PathOutsideRootError);
  });
});

describe('id builders and parseId', () => {
  it('builds the SPEC 2.1 formats', () => {
    expect(fileId('src/a.ts')).toBe('file:src/a.ts');
    expect(symId('src/a.ts', 'foo')).toBe('sym:src/a.ts#foo');
    expect(symId('src/a.ts', 'Cart.add')).toBe('sym:src/a.ts#Cart.add');
    expect(routeId('/orders/:id')).toBe('route:/orders/:id');
    expect(chunkId('src/a.ts', 'foo', 2)).toBe('chunk:src/a.ts#foo#2');
    expect(chunkId('src/A.vue', '_template', 0)).toBe('chunk:src/A.vue#_template#0');
    expect(convId('script-setup')).toBe('conv:script-setup');
  });
  it('round-trips every kind', () => {
    expect(parseId(fileId('src/a.ts'))).toEqual({ kind: 'file', path: 'src/a.ts' });
    expect(parseId(symId('src/a.vue', 'A'))).toEqual({ kind: 'sym', path: 'src/a.vue', name: 'A' });
    expect(parseId(symId('src/a.ts', 'Cart.add'))).toEqual({ kind: 'sym', path: 'src/a.ts', name: 'Cart.add' });
    expect(parseId(routeId('/orders/:id'))).toEqual({ kind: 'route', fullPath: '/orders/:id' });
    expect(parseId(chunkId('src/a.ts', 'Cart.add', 12))).toEqual({
      kind: 'chunk',
      path: 'src/a.ts',
      symbol: 'Cart.add',
      n: 12,
    });
    expect(parseId(convId('script-setup'))).toEqual({ kind: 'conv', slug: 'script-setup' });
  });
  it('rejects malformed ids', () => {
    for (const bad of ['', 'nope', 'file:', 'sym:src/a.ts', 'sym:#x', 'chunk:src/a.ts#foo', 'chunk:a#b#x', 'other:thing']) {
      expect(parseId(bad), bad).toBeNull();
    }
  });
});

describe('edgeKey', () => {
  it('uses from|kind|to and keeps the direction of directed edges', () => {
    expect(edgeKey('a', 'imports', 'b')).toBe('a|imports|b');
    expect(edgeKey('b', 'imports', 'a')).toBe('b|imports|a');
  });
  it('orders the endpoints of symmetric co_changed edges', () => {
    expect(edgeKey('file:b', 'co_changed', 'file:a')).toBe('file:a|co_changed|file:b');
    expect(edgeKey('file:a', 'co_changed', 'file:b')).toBe(edgeKey('file:b', 'co_changed', 'file:a'));
  });
});

describe('componentName', () => {
  it('PascalCases the basename', () => {
    expect(componentName('src/components/order-summary.vue')).toBe('OrderSummary');
    expect(componentName('src/CheckoutButton.vue')).toBe('CheckoutButton');
    expect(componentName('a/b/my_cool.item.vue')).toBe('MyCoolItem');
  });
  it('uses the parent folder for index.vue', () => {
    expect(componentName('src/layouts/components/Sidebar/index.vue')).toBe('Sidebar');
    expect(componentName('src/components/notify-panel/index.vue')).toBe('NotifyPanel');
    expect(componentName('index.vue')).toBe('Index');
  });
});
