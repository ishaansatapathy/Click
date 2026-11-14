import { defineConfig } from 'vitest/config';

// Fast suite: runs in `pnpm check` (and therefore on every `pnpm pair:sync`).
// Slow integration suites (*.slow.test.ts, real git worktrees) run with `pnpm test:slow`.
export default defineConfig({
  test: {
    include: ['packages/*/{src,test}/**/*.test.ts', 'bench/{src,scripts,e2e}/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/fixtures/**', '**/node_modules/**', '**/dist/**', '**/*.slow.test.ts'],
    environment: 'node',
  },
});
