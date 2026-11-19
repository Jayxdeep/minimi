import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Each test file owns its own database, so files can run concurrently.
    fileParallelism: true,
  },
});
