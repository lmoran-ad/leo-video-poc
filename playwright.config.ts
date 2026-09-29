import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

if (existsSync('.env')) process.loadEnvFile();

export const AUTH_STATE = 'auth/state.json';
// Playwright empties outputDir on every run, so paid-run evidence goes where no later run can wipe it.
// Workers re-load this file; the env var keeps them on the main process's folder.
process.env.LEO_RUN_STAMP ??= new Date().toISOString().replace(/[:.]/g, '-');
const PAID_RUN = ['LEO_VIDEO_RUN', 'LEO_VIDEO_API_RUN', 'LEO_AI_RUN'].some((flag) => process.env[flag] === '1');
export const OUTPUT_DIR = PAID_RUN ? `runs/paid-${process.env.LEO_RUN_STAMP}` : 'test-results';

export default defineConfig({
  testDir: 'tests',
  outputDir: OUTPUT_DIR,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'https://airm.therealbrokerage.com',
    channel: 'chrome',
    headless: false,
    viewport: { width: 1440, height: 900 },
    // Tracing.stop hangs in the runner on Leo pages (built-in and manual); video + screenshots until solved
    trace: 'off',
    video: 'on',
    screenshot: 'on',
  },
  projects: [
    { name: 'unit', testMatch: /(totp|leoApi)\.spec\.ts/ },
    { name: 'api', testMatch: /\.api\.spec\.ts/ },
    { name: 'claude', testMatch: /leoClaude\.spec\.ts/, timeout: 10 * 60_000 },
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'leo',
      testMatch: /leo-(video|scenario)\.spec\.ts/,
      dependencies: ['setup'],
      use: { storageState: AUTH_STATE },
    },
  ],
});
