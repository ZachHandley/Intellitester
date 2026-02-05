import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000, // 60 seconds for integration tests
    hookTimeout: 30000, // 30 seconds for setup/teardown
    passWithNoTests: true, // Don't fail when no integration tests exist
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true, // Run integration tests sequentially to avoid resource contention
      },
    },
    // Global setup and teardown
    globalSetup: './tests/integration/setup.ts',
    globalTeardown: './tests/integration/teardown.ts',
    // Retry flaky tests once
    retry: 1,
    // Fail fast on first failure in CI
    bail: process.env.CI ? 1 : 0,
  },
});
