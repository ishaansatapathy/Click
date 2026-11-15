/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- copied into the benchmark repo, whose aliases and dependencies differ from Click's.
import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';

import { usePagination } from '@/common/composables/usePagination';

describe('pagination request coordination', () => {
  it('runs immediately on page one and watches later page changes', async () => {
    const callback = vi.fn();
    const pagination = usePagination({ callback, currentPage: 1 });
    pagination.resetCurrentPage();
    expect(callback).toHaveBeenCalledTimes(1);

    pagination.watchPagination({ immediate: false });
    pagination.handleCurrentChange(2);
    await nextTick();
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
