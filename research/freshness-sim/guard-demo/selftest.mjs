// node guard-demo/selftest.mjs -- runs the real guard.js against the real demo server over loopback HTTP.
process.env.DELTA_MS = '600'; process.env.CDN_CACHE_MS = '5000'; process.env.WRITE_MS = '400'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const { server } = await import('./server.mjs')
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
const guardSource = readFileSync(new URL('./guard.js', import.meta.url), 'utf8')
const native = globalThis.fetch
// Each load gets its own global object (like a fresh page), with its own Date that the test can break.
let fetch
const load = (cfg, brokenClock = false) => {
  const page = vm.createContext({ fetch: native, crypto, performance, atob, btoa, TextEncoder, TextDecoder, URL, __NODEX_GUARD_CONFIG: { base, ...cfg } })
  if (brokenClock) vm.runInContext('Date.now = () => 0', page)
  vm.runInContext(guardSource, page)
  fetch = page.fetch
  return page.NodexGuard
}

// Shadow: verdicts are recorded, responses are untouched.
let g = load({ routes: '/cdn/api/products/', mode: 'shadow' })
const first = await (await fetch(base + '/cdn/api/products/1')).json()
assert.deepEqual({ ...g.counts }, { fresh: 1, stale: 0, unsigned: 0, forged: 0, replaced: 0, blocked: 0 })
await sleep(1000) // the cache still serves the first response, now past its 600 ms signed window
const second = await (await fetch(base + '/cdn/api/products/1')).json()
assert.equal(second.version, first.version, 'shadow mode must not alter what the page receives')
assert.equal(g.counts.stale, 1); assert.ok(g.worst() >= 300, 'overrun measured without trusting Date.now()')

// A wrong wall clock must not change the verdict (the guard runs on a calibrated monotonic clock).
g = load({ routes: '/origin/api/products/', mode: 'shadow' }, true)
await fetch(base + '/origin/api/products/1')
assert.equal(g.counts.fresh, 1, 'fresh origin read is fresh even when the page wall clock reads 1970')
g = load({ routes: '/cdn/api/products/', mode: 'shadow' }, true)
await fetch(base + '/cdn/api/products/1')
assert.equal(g.counts.stale, 1, 'and a stale one is still stale')

// Tampered body: signature binds the digest.
g = load({ routes: '/tampered/api/products/', mode: 'shadow' })
await fetch(base + '/tampered/api/products/1')
assert.equal(g.counts.forged, 1)

// Enforce: the stale cached response is replaced by a verified fresh one; a path with no fresh source fails closed.
g = load({ routes: '/cdn/api/products/', fresh: '/origin/api/products/', mode: 'enforce' })
const fixed = await (await fetch(base + '/cdn/api/products/1')).json()
assert.ok(fixed.version > first.version, 'enforce mode returned the current version'); assert.equal(g.counts.replaced, 1)
g = load({ routes: '/tampered/api/products/', fresh: '/tampered/api/products/', mode: 'enforce' })
await assert.rejects(fetch(base + '/tampered/api/products/1'), /could be verified/)
assert.equal(g.counts.blocked, 1)

await sleep(100)
const stats = await (await native(base + '/nodex/stats')).json()
assert.ok(stats.stale >= 2 && stats.forged >= 2 && stats.fresh >= 3, 'receipt endpoint aggregated the beacons: ' + JSON.stringify(stats))
server.close(); server.closeAllConnections?.()
console.log('ok: shadow, wrong-clock, tamper, enforce-replace, fail-closed, receipt', JSON.stringify(stats))
