import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/auth',
  workers: 1,
  timeout: 60000,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5175', ...devices['Desktop Chrome'], timezoneId: 'Asia/Kolkata', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run dev -- --port 5175 --strictPort',
    env: { VITE_USE_FIREBASE_EMULATORS: 'true' },
    url: 'http://127.0.0.1:5175',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
