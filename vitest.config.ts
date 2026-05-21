import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/shared/**/*.test.ts',
      'src/server/**/*.test.ts',
      'src/p2p/**/*.test.ts',
      'src/sw/freshness.test.ts',
      'src/sw/cache.test.ts',
      'src/dashboard/dashboard.test.ts',
      'src/gossip/**/*.test.ts',
      'src/crypto/**/*.test.ts',
    ],
    exclude: [
      'tests/**',
      'node_modules/**',
      'dist/**',
    ],
  },
})
