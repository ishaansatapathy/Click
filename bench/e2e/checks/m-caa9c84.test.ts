/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- copied into the benchmark repo, whose aliases and dependencies differ from Click's.
import { describe, expect, it, vi } from 'vitest';

vi.mock('vue-router', () => ({ createWebHashHistory: vi.fn(() => ({})), createWebHistory: vi.fn(() => ({})) }));

describe('shared route paths', () => {
  it('exposes one canonical dashboard and redirect path', async () => {
    const config = await import('@/router/config');
    expect(config.DASHBOARD_PATH).toBe('/dashboard');
    expect(config.REDIRECT_PATH).toBe('/redirect');
  }, 30_000);
});
