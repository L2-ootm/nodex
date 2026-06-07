import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const targets = [
  'dist',
  'apps/beta-suite/public/assets',
  'apps/beta-suite/public/metrics.html',
  'apps/beta-suite/public/registerSW.js',
  'apps/beta-suite/public/sw.js',
]

for (const target of targets) {
  await rm(resolve(root, target), { recursive: true, force: true })
}

console.log('[clean-runtime-dist] removed stale protocol runtime assets')
