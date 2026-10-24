import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/data/cloud.integration.test.ts'],
    environment: 'node',
    env: { VITE_USE_FIREBASE_EMULATORS: 'true' },
    testTimeout: 30000,
    hookTimeout: 30000,
    maxWorkers: 1,
  },
});
