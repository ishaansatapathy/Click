/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- copied into the benchmark repo, whose aliases and dependencies differ from Click's.
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {};
  const instance = Object.assign(vi.fn(), {
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn((_fulfilled: unknown, rejected: unknown) => { state.rejected = rejected; }) },
    },
  });
  return { state, instance, message: vi.fn() };
});

vi.mock('axios', () => ({ default: { create: () => mocks.instance } }));
vi.mock('@@/utils/cache/cookies', () => ({ getToken: () => '' }));
vi.mock('@/pinia/stores/user', () => ({ useUserStore: () => ({ logout: vi.fn() }) }));
vi.stubGlobal('ElMessage', { error: mocks.message });

describe('HTTP authorization errors', () => {
  it('uses the server-provided forbidden message', async () => {
    await import('@/http/axios');
    const error = { message: 'original', response: { status: 403, data: { message: 'Account is suspended' } } };
    const rejected = mocks.state.rejected as (reason: object) => Promise<unknown>;
    await expect(rejected(error)).rejects.toBe(error);
    expect(error.message).toBe('Account is suspended');
  }, 30_000);
});
