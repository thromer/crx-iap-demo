import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The network-backed suite drives the real test-server, which listens on fixed ports —
    // so test files must not run concurrently against it.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
