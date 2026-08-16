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
  // Test 65 (stallAuthorization over six minutes) is tagged @slow in its title and excluded by
  // default — it alone would multiply the whole suite's runtime several times over. Run it
  // explicitly with `npx playwright test --grep @slow`.
  grepInvert: /@slow/,
});
