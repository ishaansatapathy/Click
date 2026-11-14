import { defineConfig } from 'vitest/config';

// Slow integration suites. Run with `pnpm test:slow` whenever scripts/pair changes.
export default defineConfig({
  test: {
    include: ['**/*.slow.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'bench/repo/**'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
