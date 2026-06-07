import { cp, copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const root = process.cwd()
const copies = [
  ['dist/sw.js', 'apps/beta-suite/public/sw.js'],
  ['dist/registerSW.js', 'apps/beta-suite/public/registerSW.js'],
  ['dist/metrics.html', 'apps/beta-suite/public/metrics.html'],
  ['src/dashboard/assets/nodex-x-emblem-clean.png', 'apps/beta-suite/public/assets/nodex-x-emblem-clean.png'],
] as const

for (const [from, to] of copies) {
  const target = resolve(root, to)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(resolve(root, from), target)
}
await cp(resolve(root, 'dist/assets'), resolve(root, 'apps/beta-suite/public/assets'), {
  recursive: true,
  force: true,
})

console.log(`[sync-beta-runtime] copied protocol runtime into Next public assets`)
