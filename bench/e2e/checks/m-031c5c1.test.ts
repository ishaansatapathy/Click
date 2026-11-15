/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- copied into the benchmark repo, whose aliases and dependencies differ from Click's.
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {};
  const instance = Object.assign(vi.fn(), {
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn((fulfilled: unknown) => { state.fulfilled = fulfilled; }) },
    },
  });
  return { state, instance };
});

vi.mock('axios', () => ({ default: { create: () => mocks.instance } }));
vi.mock('@@/utils/local-storage', () => ({ getToken: () => '' }));
vi.mock('@/pinia/stores/user', () => ({ useUserStore: () => ({ logout: vi.fn() }) }));
vi.stubGlobal('ElMessage', { error: vi.fn() });

describe('business API errors', () => {
  it('rejects with the original response payload', async () => {
    await import('@/http/axios');
    const payload = { code: 9001, message: 'quota reached', details: { retry: false } };
    const fulfilled = mocks.state.fulfilled as (response: object) => Promise<unknown>;
    await expect(fulfilled({ data: payload, config: {} })).rejects.toBe(payload);
  }, 30_000);
});
