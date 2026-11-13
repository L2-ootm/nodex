// node guard-demo/server.mjs   -> http://localhost:4810
// Loopback demo origin: signs every snapshot (one middleware-sized function), plus two deliberately
// bad delivery paths so the guard has something to catch. Not production code.
import http from 'node:http'
import { readFileSync } from 'node:fs'

const DELTA = Number(process.env.DELTA_MS ?? 5000)      // signed validity window
const CACHE = Number(process.env.CDN_CACHE_MS ?? 20000) // the "forgotten" cache in front of the origin
const WRITE = Number(process.env.WRITE_MS ?? 8000)      // price changes this often
const file = name => readFileSync(new URL(name, import.meta.url))

const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const publicJwk = await crypto.subtle.exportKey('jwk', publicKey)
const b64 = buf => Buffer.from(buf).toString('base64')
const started = Date.now()
const stats = { fresh: 0, stale: 0, unsigned: 0, forged: 0, worstOverMs: 0 }

/** The whole origin-side integration: sign (resource, version, window, body digest). */
async function signed(resource) {
  const version = 1 + Math.floor((Date.now() - started) / WRITE)
  const body = JSON.stringify({ id: resource.split('/').pop(), price: (19.9 + version).toFixed(2), version })
  const validatedAt = Date.now(), validUntil = validatedAt + DELTA
  const digest = b64(await crypto.subtle.digest('SHA-256', Buffer.from(body)))
  const sig = b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey,
    Buffer.from(JSON.stringify(['nodex-guard-v1', resource, version, validatedAt, validUntil, digest]))))
  return { body, proof: b64(JSON.stringify({ resource, version, validatedAt, validUntil, digest, sig })) }
}

const cdn = new Map() // path -> { at, entry }: a cache that ignores the origin's freshness intent
export const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x')
  const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }); res.end(body) }
  const m = pathname.match(/^\/(origin|cdn|tampered)(\/api\/products\/[\w-]+)$/)
  if (m) {
    const [, via, resource] = m
    let entry
    if (via === 'cdn') {
      const hit = cdn.get(resource)
      entry = hit && Date.now() - hit.at < CACHE ? hit.entry : await signed(resource)
      if (!hit || hit.entry !== entry) cdn.set(resource, { at: Date.now(), entry })
    } else entry = await signed(resource)
    const body = via === 'tampered' ? entry.body.replace(/"price":"[\d.]+"/, '"price":"0.01"') : entry.body
    return send(200, 'application/json', body, { 'Nodex-Proof': entry.proof })
  }
  if (pathname === '/.well-known/nodex-key.json') return send(200, 'application/json', JSON.stringify({ publicJwk, serverTime: Date.now(), maxAgeMs: DELTA }))
  if (pathname === '/nodex/report' && req.method === 'POST') {
    let raw = ''
    for await (const chunk of req) { raw += chunk; if (raw.length > 2048) break } // trust boundary: bounded body
    try {
      const r = JSON.parse(raw)
      if (Object.hasOwn(stats, r.status) && r.status !== 'worstOverMs') stats[r.status]++
      if (Number.isFinite(r.overMs) && r.overMs > stats.worstOverMs) stats.worstOverMs = Math.min(r.overMs, 86400000)
    } catch { /* ignore malformed beacon */ }
    return send(204, 'text/plain', '')
  }
  if (pathname === '/nodex/stats') return send(200, 'application/json', JSON.stringify(stats))
  if (pathname === '/guard.js') return send(200, 'text/javascript', file('./guard.js'))
  if (pathname === '/') return send(200, 'text/html; charset=utf-8', file('./index.html'))
  send(404, 'text/plain', 'not found')
})

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())) {
  const port = Number(process.env.PORT ?? 4810)
  server.listen(port, '127.0.0.1', () => console.log(`guard demo on http://localhost:${port}  (window ${DELTA} ms, bad cache ${CACHE} ms)`))
}
