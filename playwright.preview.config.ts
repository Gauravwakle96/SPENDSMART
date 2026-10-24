import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Run the same workflows against dist so lazy chunks and production CSS are checked.
// Build first with npm run build.
export default defineConfig({
  ...base,
  outputDir: 'test-results/preview',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/preview' }]],
  use: { ...base.use, baseURL: 'http://127.0.0.1:4173' },
  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
