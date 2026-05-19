import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  timeout: 30000,
  testDir: 'tests',
  use: {
    baseURL: 'http://localhost:3000',
    serviceWorkers: 'allow',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'npm run server',
      port: 3001,
      reuseExistingServer: true,
    },
    {
      command: 'npm run dev:vite',
      port: 3000,
      reuseExistingServer: true,
    },
  ],
})
