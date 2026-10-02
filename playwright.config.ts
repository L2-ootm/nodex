import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  timeout: 30000,
  testDir: 'tests',
  testMatch: '**/*.spec.ts',
  testIgnore: ['beta-next.spec.ts', 'beta-real.spec.ts'],
  workers: 1,
  use: {
    baseURL: 'http://localhost:4173',
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
      port: 33001,
      reuseExistingServer: false,
      env: { ...process.env, NODEX_ENABLE_TEST_FAULTS: 'true', NODEX_API_PORT: '33001' },
    },
    {
      // Build first, then serve the built dist/ in preview mode (which includes sw.js).
      // Dev mode (vite-plugin-pwa injectManifest) does not serve sw.js at /sw.js in dev.
      // preview mode also proxies /api/* to port 3001 via vite.config.ts preview.proxy.
      command: 'npm run build && npx vite preview --port 4173 --strictPort',
      port: 4173,
      env: { ...process.env, NODEX_API_PORT: '33001' },
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: 'npm run signaling',
      port: 3002,
      reuseExistingServer: true,
    },
  ],
})
