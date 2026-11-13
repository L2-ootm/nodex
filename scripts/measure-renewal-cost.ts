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

// Signing load: a burst of renewal requests for one key should cost O(1) signatures per reuse window.
const subtle = globalThis.crypto.subtle
const realSign = subtle.sign.bind(subtle)
let signs = 0
subtle.sign = ((...args: Parameters<typeof realSign>) => {
  const name = typeof args[0] === 'string' ? args[0] : args[0].name
  if (name === 'ECDSA') signs++ // HMAC IV derivations are counted separately and are cheap
  return realSign(...args)
}) as typeof subtle.sign
const burst = 500
const path = '/api/products/burst'
seqCounters.set(path, 1)
const started = performance.now()
await Promise.all(Array.from({ length: burst }, () => app.request(`${path}/proof`)))
const elapsedMs = performance.now() - started
console.log(`\nrenewal_burst_requests,ecdsa_signatures,elapsed_ms\n${burst},${signs},${elapsedMs.toFixed(0)}`)
