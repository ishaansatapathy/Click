/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- copied into the benchmark repo, whose aliases and dependencies differ from Click's.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@@/utils/local-storage', () => ({ getLayoutsConfig: () => ({ showSettings: false, showLogo: false }) }));

describe('layout settings safety', () => {
  it('does not let cached preferences disable the settings panel', async () => {
    const { layoutsConfig } = await import('@/layouts/config');
    expect(layoutsConfig.showSettings).toBe(true);
    expect(layoutsConfig.showLogo).toBe(false);
  }, 30_000);
});
