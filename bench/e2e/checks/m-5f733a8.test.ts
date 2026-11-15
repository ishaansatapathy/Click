/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- copied into the benchmark repo, whose aliases and dependencies differ from Click's.
import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  removeToken: vi.fn(), resetRouter: vi.fn(), replace: vi.fn(), delVisited: vi.fn(), delCached: vi.fn(),
}));

vi.mock('@@/apis/users', () => ({ getCurrentUserApi: vi.fn() }));
vi.mock('@@/utils/local-storage', () => ({ getToken: () => '', setToken: vi.fn(), removeToken: mocks.removeToken }));
vi.mock('@/pinia', () => ({ pinia: undefined }));
vi.mock('@/router', () => ({ resetRouter: mocks.resetRouter, router: { replace: mocks.replace } }));
vi.mock('@/router/config', () => ({ routerConfig: { defaultRoles: [] } }));
vi.mock('@/pinia/stores/settings', () => ({ useSettingsStore: () => ({ cacheTagsView: false }) }));
vi.mock('@/pinia/stores/tags-view', () => ({
  useTagsViewStore: () => ({ delAllVisitedViews: mocks.delVisited, delAllCachedViews: mocks.delCached }),
}));

describe('centralized logout', () => {
  it('clears user state and redirects to login', async () => {
    setActivePinia(createPinia());
    const { useUserStore } = await import('@/pinia/stores/user');
    const store = useUserStore();
    store.logout();
    expect(mocks.removeToken).toHaveBeenCalledOnce();
    expect(mocks.resetRouter).toHaveBeenCalledOnce();
    expect(mocks.replace).toHaveBeenCalledWith('/login');
    expect(mocks.delVisited).toHaveBeenCalledOnce();
    expect(mocks.delCached).toHaveBeenCalledOnce();
  }, 30_000);
});
