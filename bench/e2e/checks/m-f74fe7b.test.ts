/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- copied into the benchmark repo, whose aliases and dependencies differ from Click's.
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getToken: vi.fn(() => undefined) }));

vi.mock('nprogress', () => ({ default: { configure: vi.fn(), start: vi.fn(), done: vi.fn() } }));
vi.mock('@@/composables/useRouteListener', () => ({ setRouteChange: vi.fn() }));
vi.mock('@@/composables/useTitle', () => ({ useTitle: () => ({ setTitle: vi.fn() }) }));
vi.mock('@@/utils/cache/cookies', () => ({ getToken: mocks.getToken }));
vi.mock('@/pinia/stores/permission', () => ({ usePermissionStore: () => ({ addRoutes: [] }) }));
vi.mock('@/pinia/stores/user', () => ({ useUserStore: () => ({ roles: [], resetToken: vi.fn(), getInfo: vi.fn() }) }));
vi.mock('@/router/config', () => ({ routerConfig: { dynamic: false } }));
vi.mock('@/router/whitelist', () => ({ isWhiteList: () => false }));

describe('login redirect preservation', () => {
  it('sends an unauthenticated user to login with the requested URL', async () => {
    const { registerNavigationGuard } = await import('@/router/guard');
    let beforeEach: ((to: { path: string; fullPath: string }, from: object) => unknown) | undefined;
    const router = {
      beforeEach: (handler: typeof beforeEach) => { beforeEach = handler; },
      afterEach: vi.fn(),
      addRoute: vi.fn(),
    };
    registerNavigationGuard(router as never);
    await expect(beforeEach!({ path: '/reports', fullPath: '/reports?month=9' }, {}))
      .resolves.toBe('/login?redirect=%2Freports%3Fmonth%3D9');
  }, 30_000);
});
