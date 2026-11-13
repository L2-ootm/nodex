/* Nodex Guard: drop-in freshness audit for public snapshot routes. Classic script, no dependencies.
 *
 *   <script src="/guard.js" data-routes="/cdn/api/products/" data-mode="shadow" async></script>
 *
 * shadow  : verify every matching GET, report the verdict, never change the response.
 * enforce : a stale or unverifiable response is replaced by one refetch through data-fresh; if that
 *           also fails verification the read rejects (fail closed).
 * No Service Worker, no peers, no signaling: zero control-plane cost. It only wraps window.fetch, so
 * XHR, <img> and navigations are not covered (shortcut: page-level only; move into the SW to enforce site-wide).
 */
(() => {
  const g = globalThis
  const tag = typeof document !== 'undefined' ? document.currentScript : null
  const cfg = Object.assign({ routes: '/api/products/', mode: 'shadow', fresh: '', base: '', key: '/.well-known/nodex-key.json', report: '/nodex/report' },
    tag ? Object.fromEntries(Object.entries(tag.dataset)) : {}, g.__NODEX_GUARD_CONFIG || {})
  const nativeFetch = g.fetch.bind(g)
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))
  const counts = { fresh: 0, stale: 0, unsigned: 0, forged: 0, replaced: 0, blocked: 0 }
  let worstStaleMs = 0

  // Calibrated clock: server time sampled once, advanced by the monotonic clock. Immune to a wrong or
  // stepped wall clock; error is bounded by the round trip of the key fetch (publisher-proof.ts:80 uses raw Date.now()).
  let identity = null
  const ready = (async () => {
    const t0 = performance.now()
    const res = await nativeFetch(cfg.base + cfg.key, { cache: 'no-store' })
    const body = await res.json()
    const t1 = performance.now()
    identity = {
      key: await crypto.subtle.importKey('jwk', body.publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']),
      serverAtT1: body.serverTime + (t1 - t0) / 2, t1, rttMs: t1 - t0, maxAgeMs: body.maxAgeMs,
    }
  })()
  const now = () => identity.serverAtT1 + (performance.now() - identity.t1)

  async function verdict(path, res) {
    await ready
    const header = res.headers.get('Nodex-Proof')
    if (!header) return { status: 'unsigned' }
    let p
    try { p = JSON.parse(new TextDecoder().decode(b64(header))) } catch { return { status: 'forged' } }
    const body = new Uint8Array(await res.clone().arrayBuffer())
    const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', body))))
    const signed = new TextEncoder().encode(JSON.stringify(['nodex-guard-v1', p.resource, p.version, p.validatedAt, p.validUntil, p.digest]))
    const okSig = Number.isSafeInteger(p.validatedAt) && Number.isSafeInteger(p.validUntil) &&
      p.validUntil - p.validatedAt <= identity.maxAgeMs && p.digest === digest && path.endsWith(p.resource) &&
      await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, identity.key, b64(p.sig), signed).catch(() => false)
    if (!okSig) return { status: 'forged' }
    const t = now()
    const ageMs = Math.round(t - p.validatedAt)
    if (p.validatedAt > t + identity.rttMs + 250 || p.validUntil <= t) return { status: 'stale', ageMs, version: p.version, overMs: Math.round(t - p.validUntil) }
    return { status: 'fresh', ageMs, version: p.version }
  }

  function record(path, v) {
    counts[v.status]++
    if (v.status === 'stale' && v.overMs > worstStaleMs) worstStaleMs = v.overMs
    const detail = { path, ...v, mode: cfg.mode, counts: { ...counts }, worstStaleMs }
    if (typeof g.dispatchEvent === 'function' && typeof CustomEvent === 'function') g.dispatchEvent(new CustomEvent('nodex:verdict', { detail }))
    // Aggregated receipt; one small beacon per verdict in the demo. shortcut: no batching, add before production.
    nativeFetch(cfg.base + cfg.report, { method: 'POST', keepalive: true, body: JSON.stringify({ path, status: v.status, ageMs: v.ageMs ?? null, overMs: v.overMs ?? null }) }).catch(() => {})
    return detail
  }

  g.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    const method = (init && init.method) || (typeof input === 'object' && input.method) || 'GET'
    const path = new URL(url, cfg.base || g.location.href).pathname
    if (method !== 'GET' || !path.startsWith(cfg.routes)) return nativeFetch(input, init)
    const res = await nativeFetch(input, init)
    const v = await verdict(path, res).catch(() => ({ status: 'forged' }))
    record(path, v)
    if (cfg.mode !== 'enforce' || v.status === 'fresh') return res
    // Enforce: one refetch through the route the customer excluded from caching, then fail closed.
    const freshPath = cfg.fresh + path.slice(cfg.routes.length)
    const again = await nativeFetch(cfg.base + freshPath, { cache: 'no-store' })
    const v2 = await verdict(freshPath, again).catch(() => ({ status: 'forged' }))
    record(freshPath, v2)
    if (v2.status === 'fresh') { counts.replaced++; return again }
    counts.blocked++
    throw new TypeError('Nodex Guard: no response for ' + path + ' could be verified as current')
  }
  g.NodexGuard = { counts, config: cfg, ready, worst: () => worstStaleMs }
})()
