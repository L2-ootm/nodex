import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
  },
  plugins: [
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/sw',
      filename: 'sw.ts',
      injectManifest: {
        // Do not inject Workbox precache manifest — Nodex manages its own cache
        injectionPoint: undefined,
      },
    }),
  ],
})
