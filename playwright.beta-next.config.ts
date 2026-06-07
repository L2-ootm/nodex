import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  timeout: 30000,
  testDir: 'tests',
  testMatch: 'beta-next.spec.ts',
  workers: 1,
  use: {
    baseURL: 'http://localhost:4175',
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run beta:next:build && next start apps/beta-suite --port 4175',
    port: 4175,
    reuseExistingServer: false,
    timeout: 120000,
  },
})
