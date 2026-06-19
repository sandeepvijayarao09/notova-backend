import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      // Pure runtime wiring exercised only by a live server / migration runner
      // is excluded from coverage targets; the rest is covered by tests.
      exclude: ['src/index.ts', 'src/db/migrate.ts', 'src/middleware/logger.ts'],
    },
  },
});
