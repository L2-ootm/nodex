import { defineConfig, devices } from '@playwright/test'

const api = 'http://localhost:33003'
const app = 'http://localhost:4176'
export default defineConfig({
  testDir: 'tests', testMatch: 'beta-real.spec.ts', workers: 1, timeout: 45000,
  use: { baseURL: app, serviceWorkers: 'allow' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    // The suite owns this directory; stale enrollments from a prior run make the second run fail.
    { command: `node -e "require('node:fs').rmSync('beta-data/real-browser-test',{recursive:true,force:true})" && npm run beta:server`,
      url: api + '/api/beta/health', reuseExistingServer: false,
      env: { NODE_ENV: 'development', NODEX_BETA_PORT: '33003', NODEX_BETA_APP_ORIGIN: app,
        NODEX_BETA_DATA_DIR: 'beta-data/real-browser-test', NODEX_BETA_ENFORCE_AUTH: 'false' } },
    { command: 'npm run beta:next:build && next start apps/beta-suite --port 4176', url: app,
      reuseExistingServer: false, timeout: 120000, env: { NEXT_PUBLIC_NODEX_BETA_API_URL: api } },
  ],
})
