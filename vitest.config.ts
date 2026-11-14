import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/{src,test}/**/*.test.ts', 'bench/{src,scripts,e2e}/**/*.test.ts'],
    exclude: ['**/fixtures/**', '**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
});
