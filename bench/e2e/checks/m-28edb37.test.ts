import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('notification ages', () => {
  it('shows the Vite launch as one year old and the original launch as two', () => {
    const path = ['src/common/components/Notify/data.ts', 'src/components/Notify/data.ts'].find(existsSync);
    expect(path).toBeTruthy();
    const source = readFileSync(path!, 'utf8');
    expect(source).toMatch(/title:\s*"V3 Admin Vite 上线啦"[\s\S]*?datetime:\s*"一年前"/);
    expect(source).toMatch(/title:\s*"V3 Admin 上线啦"[\s\S]*?datetime:\s*"两年前"/);
  });
});
