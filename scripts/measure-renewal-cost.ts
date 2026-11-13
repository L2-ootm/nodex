// Measured artifact: wire bytes of a full payload response versus a proof renewal, on the real
// handlers (in-process; counts header and body bytes, excludes TLS and HTTP framing).
import { app, snapshots, seqCounters } from '../src/server/mock-api.js'

function headerBytes(res: Response): number {
  let total = 0
  res.headers.forEach((value, name) => { total += name.length + value.length + 4 })
  return total
}
const rows: string[] = ['payload_plaintext_bytes,full_response_bytes,renewal_response_bytes,renewal_fraction']
for (const size of [256, 1024, 8 * 1024, 32 * 1024, 60 * 1024]) {
  const path = `/api/products/size-${size}`
  seqCounters.set(path, 1)
  snapshots.set(path, { id: `size-${size}`, blob: 'x'.repeat(size - 40) })
  const full = await app.request(path)
  const fullBytes = headerBytes(full) + (await full.arrayBuffer()).byteLength
  const renewal = await app.request(`${path}/proof`)
  const renewalBytes = headerBytes(renewal) + (await renewal.arrayBuffer()).byteLength
  rows.push(`${size},${fullBytes},${renewalBytes},${(renewalBytes / fullBytes).toFixed(3)}`)
}
console.log(rows.join('\n'))
