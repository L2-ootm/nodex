import { readFile } from 'node:fs/promises'
import { Script } from 'node:vm'
import { gzipSync } from 'node:zlib'

const source = await readFile('dist/sw.js', 'utf8')
new Script(source, { filename: 'dist/sw.js' }) // registered as a classic worker
if (/\bdocument\.(?:createElement|head|querySelector)/.test(source)) {
  throw new Error('Service Worker build contains a browser DOM preload helper')
}
const compressed = gzipSync(source).byteLength
if (compressed > 50 * 1024) throw new Error('Service Worker exceeds its 50 KiB gzip budget')
console.log(`Service Worker: classic-script syntax verified; gzip ${compressed} bytes`)
