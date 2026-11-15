/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- copied into the benchmark repo, whose aliases and dependencies differ from Click's.
import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ setToken: vi.fn(), reload: vi.fn() }));

vi.mock('@@/apis/users', () => ({ getCurrentUserApi: vi.fn() }));
vi.mock('@@/utils/local-storage', () => ({ getToken: () => '', setToken: mocks.setToken, removeToken: vi.fn() }));
vi.mock('@/pinia', () => ({ pinia: undefined }));
vi.mock('@/router', () => ({ resetRouter: vi.fn(), router: { replace: vi.fn() } }));
vi.mock('@/pinia/stores/settings', () => ({ useSettingsStore: () => ({ cacheTagsView: true }) }));
vi.mock('@/pinia/stores/tags-view', () => ({ useTagsViewStore: () => ({}) }));
vi.stubGlobal('location', { reload: mocks.reload });

describe('account switching', () => {
  it('switches users through the renamed action', async () => {
    setActivePinia(createPinia());
    const { useUserStore } = await import('@/pinia/stores/user');
    const store = useUserStore();
    store.changeUser('editor');
    expect(mocks.setToken).toHaveBeenCalledWith('token-editor');
    expect(mocks.reload).toHaveBeenCalledOnce();
  }, 30_000);
});
