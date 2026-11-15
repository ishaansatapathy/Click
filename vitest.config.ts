import { defineConfig } from 'vitest/config';

// Fast suite: runs in `pnpm check` (and therefore on every `pnpm pair:sync`).
// Slow integration suites (*.slow.test.ts, real git worktrees) run with `pnpm test:slow`.
export default defineConfig({
  test: {
    include: ['packages/*/{src,test}/**/*.test.ts', 'bench/{src,scripts,e2e}/**/*.test.ts', 'infra/**/*.test.ts', 'scripts/**/*.test.ts'],
    // These checks are copied into the benchmark repo and run with its Vite aliases and locked dependencies.
    exclude: ['**/fixtures/**', '**/node_modules/**', '**/dist/**', '**/*.slow.test.ts', 'bench/e2e/checks/**'],
    environment: 'node',
    // Safety nets, not perf assertions (perf budgets are SPEC §18). Real git/IO tests need headroom when
    // both pair-mode seats run pnpm check at once on one laptop.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
