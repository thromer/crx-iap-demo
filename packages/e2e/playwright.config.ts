import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  // The test server binds fixed ports (see packages/test-server/src/config.ts) and each test
  // starts its own instance, so tests cannot run concurrently.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});
