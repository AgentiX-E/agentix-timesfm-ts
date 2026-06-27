import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@agentix-e/timesfm-core': resolve(__dirname, '../timesfm-core/src/index.ts'),
      '@agentix-e/timesfm-xreg': resolve(__dirname, '../timesfm-xreg/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
