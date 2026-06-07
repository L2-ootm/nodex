import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: {
    __NODEX_COMMIT_HASH__: JSON.stringify('test'),
  },
  test: {
    environment: 'node',
    include: [
      'src/shared/**/*.test.ts',
      'src/server/**/*.test.ts',
      'src/p2p/**/*.test.ts',
      'src/sw/freshness.test.ts',
      'src/sw/cache.test.ts',
      'src/dashboard/**/*.test.ts',
      'src/gossip/**/*.test.ts',
      'src/crypto/**/*.test.ts',
      'src/volatility/**/*.test.ts',
      'tests/helpers/**/*.test.ts',
      'api/**/*.test.ts',
    ],
    exclude: [
      'tests/**/*.spec.ts',
      'node_modules/**',
      'dist/**',
    ],
  },
})
