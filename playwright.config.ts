import { defineConfig } from '@playwright/test';

const unitOnly = process.argv.some((argument) => /tests[\\/]unit/.test(argument));

export default defineConfig({
  testDir: './tests',
  // Node's *.test.ts suites have their own runners and isolated fixture state.
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5199',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: unitOnly ? undefined : {
    command: 'npm run dev -- --host 127.0.0.1 --port 5199',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
