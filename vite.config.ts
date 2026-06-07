import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import { execSync } from 'child_process'

function getCommitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  define: {
    __NODEX_COMMIT_HASH__: JSON.stringify(getCommitHash()),
  },
  root: 'src/dashboard',
  build: {
    outDir: '../../dist',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'src/dashboard/index.html'),
        metrics: path.resolve(__dirname, 'src/dashboard/metrics.html'),
        beta: path.resolve(__dirname, 'src/dashboard/beta.html'),
      },
    },
  },
  server: {
    // Proxy /api/* to the Hono mock server on port 3001 during dev/preview.
    // This allows the SW server-fallback path to resolve relative /api/* URLs
    // to the real mock API (not the static file server).
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  preview: {
    // Also proxy /api/* in preview mode (used by Playwright integration tests).
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  plugins: [
    VitePWA({
      strategies: 'injectManifest',
      srcDir: path.resolve(__dirname, 'src/sw'),
      filename: 'sw.ts',
      injectManifest: {
        // Do not inject Workbox precache manifest — Nodex manages its own cache
        injectionPoint: undefined,
      },
    }),
  ],
})
