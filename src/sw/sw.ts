// src/sw/sw.ts — Service Worker entry point
// Phase 1: install/activate lifecycle, fetch event interception,
// cache hit/miss/fallback with seq-number freshness validation,
// LRU eviction (cache.ts), and metrics emission (metrics.ts).
//
// Critical constraints (see RESEARCH.md Anti-Patterns, Pitfall 1, Pitfall 4):
//   - event.respondWith() MUST be called synchronously (no await before it)
//   - Always response.clone() before cache.put(); return the original
//   - IDB writes wrapped in try/catch; QuotaExceededError must NOT crash the SW
//   - Guard opaque responses: skip cache.put() if response.type === 'opaque'
//   - NaN guard on X-Nodex-Seq; fallback to seq=1
//   - Cache key = new URL(request.url).pathname (not full URL — D-06)
//
// STRIDE mitigations:
//   T-03-02: FLUSH_BUFFER handler validates message type before executing flush

/// <reference lib="webworker" />

import { getDb } from './idb.js'
import { seedSeqMap, updateSeq, isFresh, getLatestSeq } from './freshness.js'
import { getCachedEntry, putCachedEntry, touchAccessedAt } from './cache.js'
import { emitMetric, flushBuffer, getNodeId } from './metrics.js'
import {
  CACHE_URL_PREFIX,
  CACHE_NAME,
  META_STORE,
  METRICS_CHANNEL_NAME,
  P2P_FETCH_TIMEOUT_MS,
  VOL_COLD_START,
  VOL_P2P_GATE,
  VOLATILITY_STORE,
  ENCRYPTION_KEY_ID,
  DEFAULT_API_ORIGIN,
} from '../shared/config.js'
import type { CacheMeta, VolatilityEntry } from '../shared/types.js'
import { buildPayloadAad, decrypt as aesDecode } from '../crypto/crypto.js'
import { computeScore, classifyTier, deriveTTL } from '../volatility/volatility.js'
import { admitCandidate, observeVersion, type ConsistencyPolicy } from '../shared/consistency.js'

declare const self: ServiceWorkerGlobalScope

const SW_VERSION = '1.0.0'

// Build-time API origin — injected by Vite from VITE_NODEX_BETA_API_URL; falls back to local dev default
const SW_API_ORIGIN: string =
  (typeof (import.meta as { env?: Record<string, string> }).env !== 'undefined'
    ? (import.meta as { env?: Record<string, string> }).env?.['VITE_NODEX_BETA_API_URL']?.replace(/\/$/, '')
    : undefined) ?? DEFAULT_API_ORIGIN

// Session keys imported via IMPORT_SESSION_KEY postMessage (CRPT-02)
const sessionKeys = new Map<string, CryptoKey>()
const runtimeFlags = {
  disableP2P: false,
  disableCacheRead: false,
}

async function importSessionKey(keyId: string, keyBytes: string): Promise<void> {
  const raw = Uint8Array.from(atob(keyBytes), (c) => c.charCodeAt(0))
  const cryptoKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['decrypt'])
  sessionKeys.set(keyId, cryptoKey)
}

async function ensureSessionKey(keyId: string): Promise<CryptoKey | null> {
  const existing = sessionKeys.get(keyId)
  if (existing) return existing

  try {
    const res = await fetch('/api/session-key', { mode: 'cors' })
    if (!res.ok) return null
    const data = await res.json() as { keyId: string; keyBytes: string }
    await importSessionKey(data.keyId, data.keyBytes)
    return sessionKeys.get(keyId) ?? null
  } catch (err) {
    console.warn('[SW] ensureSessionKey failed:', err)
    return null
  }
}

async function decryptPayloadResponse(key: string, response: Response, seq: number): Promise<Response> {
  const iv = response.headers.get('X-Nodex-Iv')
  const keyId = response.headers.get('X-Nodex-Key-Id') ?? ENCRYPTION_KEY_ID
  if (!iv) {
    return response
  }

  const cryptoKey = await ensureSessionKey(keyId)
  if (!cryptoKey) {
    console.warn('[SW] Missing session key for encrypted response:', keyId)
    return new Response('Decrypt key unavailable', { status: 502 })
  }

  try {
    const ciphertext = await response.text()
    const ctBytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0))
    const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0))
    const plaintext = await aesDecode(ctBytes, ivBytes, cryptoKey, buildPayloadAad(key, seq, keyId))
    return new Response(new TextDecoder().decode(plaintext), {
      status: response.status,
      statusText: response.statusText,
      headers: {
        'Content-Type': 'application/json',
        'X-Nodex-Seq': String(seq),
      },
    })
  } catch (err) {
    console.warn('[SW] decrypt response failed:', err)
    return new Response('Decrypt error', { status: 502 })
  }
}

async function getCacheState(key: string): Promise<{
  key: string
  hasCache: boolean
  latestSeq: number
  cachedSeq: number
}> {
  let hasCache = false
  let cachedSeq = 0

  try {
    const cache = await caches.open(CACHE_NAME)
    hasCache = (await cache.match(key)) !== undefined
  } catch {
    hasCache = false
  }

  try {
    const db = await getDb()
    const meta = await db.get(META_STORE, key)
    cachedSeq = meta?.seq ?? 0
  } catch {
    cachedSeq = 0
  }

  return {
    key,
    hasCache,
    latestSeq: getLatestSeq(key),
    cachedSeq,
  }
}

async function revalidateKey(key: string): Promise<{
  key: string
  localSeqBefore: number
  serverSeq: number
  repaired: boolean
  deletedCache: boolean
}> {
  const localSeqBefore = getLatestSeq(key)
  let serverSeq = localSeqBefore

  try {
    const res = await fetch(`${SW_API_ORIGIN}/api/__test__/seq${key}`, { mode: 'cors' })
    if (res.ok) {
      const body = await res.json() as { seq: number }
      if (Number.isInteger(body.seq) && body.seq > 0) {
        serverSeq = body.seq
      }
    }
  } catch (err) {
    console.warn('[SW] REVALIDATE_KEY seq fetch failed:', err)
  }

  let deletedCache = false
  if (serverSeq > localSeqBefore) {
    updateSeq(key, serverSeq)
    try {
      const cache = await caches.open(CACHE_NAME)
      deletedCache = await cache.delete(key)
    } catch (err) {
      console.warn('[SW] REVALIDATE_KEY cache delete failed:', err)
    }
    try {
      const db = await getDb()
      await db.delete(META_STORE, key)
    } catch {
      // best-effort IDB delete
    }
  }

  return {
    key,
    localSeqBefore,
    serverSeq,
    repaired: serverSeq > localSeqBefore,
    deletedCache,
  }
}

// In-memory volatility score cache — seeded from IDB on activate, refreshed on GOSSIP_INVALIDATE
// Lookup is O(1) synchronous; no IDB reads in the fetch event hot path (VOL-05)
const scoreCache = new Map<string, number>()

// In-memory observed-version barrier — obs_s(key) per formal model Def. 4.2.
// Monotonically non-decreasing. SW session scope: persists across page reloads
// (SW stays alive), but resets on SW restart. Sufficient for PoC session guarantee.
const observedVersionMap = new Map<string, number>()

// Map volatility score to a ConsistencyPolicy for admitCandidate().
// score >= VOL_P2P_GATE entries are server-only (caught by VOL-05 gate before this runs).
// For admissible keys we use fresh-dynamic with conservative version staleness budget.
function peerReadsPolicyFromScore(score: number): ConsistencyPolicy {
  if (score >= VOL_P2P_GATE) {
    return { class: 'critical', peerReads: false }
  }
  return { class: 'fresh-dynamic', peerReads: true, maxStaleVersions: 2 }
}

// ---------------------------------------------------------------------------
// Install — skip waiting so the new SW takes control immediately
// ---------------------------------------------------------------------------

self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(self.skipWaiting())
})

// ---------------------------------------------------------------------------
// Activate — claim clients, init IDB, seed in-memory seq map, generate node ID,
//            prune old caches
// ---------------------------------------------------------------------------

async function activateSW(): Promise<void> {
  // Take control of all open clients immediately
  await self.clients.claim()
  console.log(`[SW ${SW_VERSION}] activated`)

  // Seed in-memory seq map from IDB so isFresh() works without a cold-miss penalty
  try {
    const db = await getDb()
    const allMeta: CacheMeta[] = await db.getAll(META_STORE)
    seedSeqMap(allMeta)
    console.log(`[SW] seeded seqMap with ${allMeta.length} entries`)
    // Seed observedVersionMap from IDB sentinel entries (__obs_v:{key} pattern)
    // Provides monotonic read continuity across page reloads within the same SW lifetime
    for (const entry of allMeta) {
      if (entry.path.startsWith('__obs_v:')) {
        const key = entry.path.slice('__obs_v:'.length)
        observedVersionMap.set(key, entry.seq)
      }
    }
  } catch (err) {
    // IDB unavailable — safe to continue; seqMap stays empty (all entries treated as fresh)
    console.warn('[SW] IDB seed failed:', err)
  }

  // Seed in-memory scoreCache from IDB volatility ledger (best-effort, VOL-05)
  try {
    const db = await getDb()
    const volatilityEntries: VolatilityEntry[] = await db.getAll(VOLATILITY_STORE)
    for (const entry of volatilityEntries) {
      scoreCache.set(entry.key, computeScore(entry))
    }
    console.log(`[SW] seeded scoreCache with ${volatilityEntries.length} entries`)
  } catch (err) {
    // IDB unavailable — scoreCache stays empty; all keys default to VOL_COLD_START at runtime
    console.warn('[SW] scoreCache seed failed:', err)
  }

  // Generate and store the persistent source_node_id UUID (D-16)
  try {
    await getNodeId()
    console.log('[SW] node_id initialized')
  } catch (err) {
    console.warn('[SW] node_id init failed:', err)
  }

  // Prune caches from older SW versions (any cache name that is not CACHE_NAME)
  try {
    const { CACHE_NAME } = await import('../shared/config.js')
    const cacheNames = await self.caches.keys()
    await Promise.all(
      cacheNames
        .filter((name) => name !== CACHE_NAME)
        .map((name) => self.caches.delete(name))
    )
  } catch (err) {
    console.warn('[SW] Cache pruning failed:', err)
  }
}

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(activateSW())
})

// ---------------------------------------------------------------------------
// Message — handle FLUSH_BUFFER from dashboard (T-03-02: validate type first)
// ---------------------------------------------------------------------------

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const type = event.data?.type
  // T-03-02: only process recognized message types; unknown types silently discarded
  if (type === 'FLUSH_BUFFER') {
    event.waitUntil(flushBuffer())
  } else if (type === 'GET_NODE_ID') {
    // Reply on the transferred port (event.ports[0]) so page's port1.onmessage receives it
    const replyPort = event.ports[0]
    event.waitUntil(
      getNodeId().then((nodeId) => {
        if (replyPort) {
          replyPort.postMessage({ type: 'NODE_ID', nodeId })
        } else {
          ;(event.source as Client)?.postMessage({ type: 'NODE_ID', nodeId })
        }
      })
    )
  } else if (type === 'GOSSIP_INVALIDATE') {
    // Evict stale cache entry when gossip invalidation arrives (GOSP-02)
    const { key, seq } = event.data as { key: string; seq: number }
    event.waitUntil(
      (async () => {
        updateSeq(key, seq)
        try {
          const cache = await caches.open(CACHE_NAME)
          await cache.delete(key)
        } catch (err) {
          console.warn('[SW] GOSSIP_INVALIDATE cache.delete error:', err)
        }
        try {
          const db = await getDb()
          await db.delete(META_STORE, key)
        } catch {
          // best-effort IDB delete
        }
        // Update volatility ledger on invalidation — refreshes scoreCache in-memory (VOL-05)
        try {
          const db = await getDb()
          const existing = await db.get(VOLATILITY_STORE, key)
          const entry: VolatilityEntry = existing
            ? { ...existing, change_count: existing.change_count + 1, last_changed_at: Date.now() }
            : { key, change_count: 1, last_changed_at: Date.now(), access_count: 0 }
          await db.put(VOLATILITY_STORE, entry)
          const score = computeScore(entry)
          scoreCache.set(key, score)
          // Broadcast volatility-update to dashboard for live tier display (VOL-04)
          try {
            const tier = classifyTier(score)
            const ch = new BroadcastChannel(METRICS_CHANNEL_NAME)
            ch.postMessage({ type: 'volatility-update', key, score, tier })
            ch.close()
          } catch {
            // best-effort broadcast — dashboard display is non-critical
          }
        } catch {
          // best-effort IDB write — SW correctness does not depend on it
        }
      })()
    )
  } else if (type === 'IMPORT_SESSION_KEY') {
    // Import AES-GCM session key for peer payload decryption (CRPT-02)
    const { keyId, keyBytes } = event.data as { keyId: string; keyBytes: string }
    event.waitUntil(
      (async () => {
        try {
          await importSessionKey(keyId, keyBytes)
          console.log('[SW] session key imported:', keyId)
        } catch (err) {
          console.warn('[SW] IMPORT_SESSION_KEY failed:', err)
        }
      })()
    )
  } else if (type === 'SET_RUNTIME_FLAGS') {
    const flags = event.data?.flags as { disableP2P?: boolean; disableCacheRead?: boolean } | undefined
    runtimeFlags.disableP2P = Boolean(flags?.disableP2P)
    runtimeFlags.disableCacheRead = Boolean(flags?.disableCacheRead)
    const replyPort = event.ports[0]
    if (replyPort) {
      replyPort.postMessage({ type: 'SET_RUNTIME_FLAGS_RESULT', flags: { ...runtimeFlags } })
    }
  } else if (type === 'GET_CACHE_STATE') {
    const { key } = event.data as { key: string }
    const replyPort = event.ports[0]
    event.waitUntil(
      getCacheState(key).then((state) => {
        replyPort?.postMessage({ type: 'GET_CACHE_STATE_RESULT', ...state })
      })
    )
  } else if (type === 'REVALIDATE_KEY') {
    const { key } = event.data as { key: string }
    const replyPort = event.ports[0]
    event.waitUntil(
      revalidateKey(key).then((result) => {
        replyPort?.postMessage({ type: 'REVALIDATE_KEY_RESULT', ...result })
      })
    )
  } else if (type === 'P2P_FETCH_SERVE') {
    // Serve cached payload to a requesting peer via score gate (T-04-04, VOL-05 D-10)
    const { key } = event.data as { key: string }
    const replyPort = event.ports[0]
    event.waitUntil(
      (async () => {
        // T-04-04: high-volatility keys never leave the SW — respond found: false
        const score = scoreCache.get(key) ?? VOL_COLD_START
        if (score >= VOL_P2P_GATE) {
          replyPort?.postMessage({ found: false })
          return
        }
        try {
          const cache = await caches.open(CACHE_NAME)
          const cached = await cache.match(key)
          if (!cached) {
            replyPort?.postMessage({ found: false })
            return
          }
          const payload = await cached.text()
          const seq = parseInt(cached.headers.get('X-Nodex-Seq') ?? '1', 10)
          if (!isFresh(key, seq)) {
            replyPort?.postMessage({ found: false })
            return
          }
          const iv = cached.headers.get('X-Nodex-Iv') ?? ''
          const keyId = cached.headers.get('X-Nodex-Key-Id') ?? ENCRYPTION_KEY_ID
          // Re-serve the encrypted payload as-is (server stores ciphertext; SW never decrypts for peer serve)
          replyPort?.postMessage({
            found: true,
            payload: JSON.stringify({ ciphertext: payload, iv, keyId, seq }),
          })
        } catch (err) {
          console.warn('[SW] P2P_FETCH_SERVE error:', err)
          replyPort?.postMessage({ found: false })
        }
      })()
    )
  }
})

// ---------------------------------------------------------------------------
// Fetch — intercept GET /api/* requests; everything else passes through
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event: FetchEvent) => {
  const { request } = event

  // Only intercept same-origin GET requests to the /api/ prefix (D-05, D-08).
  // Cross-origin requests (e.g. to nodex-beta-api.vercel.app) must pass through
  // unmodified so that Authorization headers reach the API server.
  const url = new URL(request.url)
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    !url.pathname.startsWith(CACHE_URL_PREFIX) ||
    url.pathname === '/api/session-key'
  ) {
    // Non-/api/, non-GET, or cross-origin: fall through to the network
    return
  }

  // CRITICAL: event.respondWith() must be called synchronously — pass the Promise directly
  event.respondWith(handleRequest(request))
})

// ---------------------------------------------------------------------------
// handleRequest — cache hit/miss/stale logic with LRU + metrics emission
// ---------------------------------------------------------------------------

async function handleRequest(request: Request): Promise<Response> {
  const key = new URL(request.url).pathname  // D-06: cache key = pathname only
  const start = self.performance.now()

  // --- Cache lookup using cache.ts ---
  const cached = runtimeFlags.disableCacheRead ? null : await getCachedEntry(key)

  if (cached) {
    const { response, meta } = cached
    const cachedSeq = meta.seq

    if (isFresh(key, cachedSeq)) {
      // Consistency admission gate (G3/G9): check obs_s barrier before accepting cache hit.
      // obs_s ensures monotonic reads: never serve a version older than one already observed.
      const cacheScore = scoreCache.get(key) ?? VOL_COLD_START
      const cacheAdmit = admitCandidate({
        candidate: {
          key,
          version: cachedSeq,
          updatedAt: meta.cached_at ?? meta.accessed_at,
          class: 'fresh-dynamic',
        },
        policy: peerReadsPolicyFromScore(cacheScore),
        sessionObservedVersion: observedVersionMap.get(key) ?? 0,
        latestKnownVersion: getLatestSeq(key),
        now: Date.now(),
      })

      if (!cacheAdmit.admitted) {
        // Session barrier or policy rejected this version — fall through to server for fresh data.
        // Emit admission-rejected metric so violations are measurable.
        const rejLatency = Math.round((self.performance.now() - start) * 100) / 100
        void emitMetric({ type: 'admission-rejected', key, latency_ms: rejLatency, rejection_reason: cacheAdmit.reason, rejection_source: 'cache' })
        console.log('[SW] admission rejected (cache):', key, 'reason:', cacheAdmit.reason, 'obs=', observedVersionMap.get(key) ?? 0, 'cachedSeq=', cachedSeq)
        // Fall through to server fetch below
      } else {
        // Admitted — update obs_s barrier to the version just served
        observedVersionMap.set(key, observeVersion(observedVersionMap.get(key) ?? 0, cachedSeq))
        // Best-effort IDB persistence for monotonic read barrier (IMPL-02)
        // Sentinel pattern: __obs_v:{key} in nodex-meta store; seq = observed version
        getDb().then(db => db.put(META_STORE, {
          path: '__obs_v:' + key,
          seq: observedVersionMap.get(key) ?? 0,
          accessed_at: Date.now(),
          byte_size: 0,
        })).catch(() => {})

        // Fresh cache hit — update LRU timestamp (best-effort)
        await touchAccessedAt(key)

        // Increment access_count in volatility ledger (best-effort, CR-01)
        getDb().then(db => {
          return db.get(VOLATILITY_STORE, key).then(existing => {
            if (existing) {
              const updated: VolatilityEntry = { ...existing, access_count: existing.access_count + 1 }
              return db.put(VOLATILITY_STORE, updated).then(() => {
                scoreCache.set(key, computeScore(updated))
              })
            }
          })
        }).catch(() => { /* best-effort — volatility ledger is non-critical */ })

        // Emit sw-cache metric (D-14)
        const latency_ms = Math.round((self.performance.now() - start) * 100) / 100
        await emitMetric({ type: 'sw-cache', key, latency_ms })

        console.log('[SW] cache-hit (fresh, admitted):', key, 'obs=', observedVersionMap.get(key))
        return decryptPayloadResponse(key, response, cachedSeq)
      }
    }

    // Stale: cached seq is behind the latest known seq — fall through to server fetch
    console.log('[SW] cache-stale, fetching from server:', key, 'cachedSeq=', cachedSeq)
  } else {
    console.log('[SW] cache-miss, fetching from server:', key)
  }

  // --- VOL-05 routing gate: skip P2P for high-volatility keys (synchronous O(1) lookup) ---
  const score = scoreCache.get(key) ?? VOL_COLD_START
  if (score >= VOL_P2P_GATE) {
    console.log('[SW] VOL-05 gate: skipping P2P, score=', score, 'key=', key)
    return fetchAndCache(request, key, start)
  }

  // --- P2P peer fetch (200ms race timeout, PEER-06) ---
  if (!runtimeFlags.disableP2P) {
    const peerResponse = await tryPeerFetch(key)
    if (peerResponse) {
      const latency_ms = Math.round((self.performance.now() - start) * 100) / 100
      await emitMetric({ type: 'peer-fetch', key, latency_ms })
      return peerResponse
    }
  }

  // --- Server fallback ---
  return fetchAndCache(request, key, start)
}

// ---------------------------------------------------------------------------
// tryPeerFetch — SW→page postMessage bridge; races against P2P_FETCH_TIMEOUT_MS
// ---------------------------------------------------------------------------

async function tryPeerFetch(key: string): Promise<Response | null> {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: false })
  if (clients.length === 0) return null

  return new Promise<Response | null>((resolve) => {
    const channel = new MessageChannel()
    const timeout = setTimeout(() => resolve(null), P2P_FETCH_TIMEOUT_MS)

    // port1 is transferred to page; SW listens on port2 to receive the reply
    channel.port2.onmessage = (event: MessageEvent) => {
      clearTimeout(timeout)
      if (
        event.data?.type === 'P2P_FETCH_RESPONSE' &&
        event.data.found &&
        event.data.payload
      ) {
        // Payload is JSON: { ciphertext: base64, iv: base64, keyId: string, seq: number }
        // CRPT-04: DTLS provides transport encryption; AES-GCM provides payload confidentiality
        // at rest and in peer-to-peer transit (DataChannel content never plaintext in flight)
        let parsed: { ciphertext: string; iv: string; keyId: string; seq: number }
        try {
          parsed = JSON.parse(event.data.payload as string) as typeof parsed
        } catch {
          resolve(null)
          return
        }
        const cryptoKey = sessionKeys.get(parsed.keyId)
        if (!cryptoKey) {
          resolve(null)
          return
        }
        const ctBytes = Uint8Array.from(atob(parsed.ciphertext), (c) => c.charCodeAt(0))
        const ivBytes = Uint8Array.from(atob(parsed.iv), (c) => c.charCodeAt(0))
        if (!isFresh(key, parsed.seq)) {
          resolve(null)
          return
        }
        // Consistency admission gate (G3/G9): check obs_s barrier before accepting peer response.
        // Runs before AES decrypt to reject stale peers cheaply (no crypto cost on rejection).
        const peerScore = scoreCache.get(key) ?? VOL_COLD_START
        const peerAdmit = admitCandidate({
          candidate: {
            key,
            version: parsed.seq,
            updatedAt: Date.now(),
            class: 'fresh-dynamic',
          },
          policy: peerReadsPolicyFromScore(peerScore),
          sessionObservedVersion: observedVersionMap.get(key) ?? 0,
          latestKnownVersion: getLatestSeq(key),
          now: Date.now(),
        })
        if (!peerAdmit.admitted) {
          void emitMetric({ type: 'admission-rejected', key, latency_ms: 0, rejection_reason: peerAdmit.reason, rejection_source: 'peer' })
          console.log('[SW] peer-fetch admission rejected:', key, 'reason:', peerAdmit.reason)
          resolve(null)
          return
        }
        // aesDecode throws DOMException(OperationError) on tamper/wrong key → server fallback (CRPT-03)
        aesDecode(ctBytes, ivBytes, cryptoKey, buildPayloadAad(key, parsed.seq, parsed.keyId))
          .then(async (plaintext: Uint8Array) => {
            const currentScore = scoreCache.get(key) ?? VOL_COLD_START
            const tier = classifyTier(currentScore)
            const ttl_ms = deriveTTL(tier)
            await putCachedEntry(
              key,
              new Response(parsed.ciphertext, {
                status: 200,
                headers: {
                  'Content-Type': 'text/plain',
                  'X-Nodex-Seq': String(parsed.seq),
                  'X-Nodex-Iv': parsed.iv,
                  'X-Nodex-Key-Id': parsed.keyId,
                },
              }),
              parsed.seq,
              ttl_ms
            )
            updateSeq(key, parsed.seq)
            // Update obs_s barrier after successful peer-fetch (monotone advance)
            observedVersionMap.set(key, observeVersion(observedVersionMap.get(key) ?? 0, parsed.seq))
            // Best-effort IDB persistence for monotonic read barrier (IMPL-02)
            // Sentinel pattern: __obs_v:{key} in nodex-meta store; seq = observed version
            getDb().then(db => db.put(META_STORE, {
              path: '__obs_v:' + key,
              seq: observedVersionMap.get(key) ?? 0,
              accessed_at: Date.now(),
              byte_size: 0,
            })).catch(() => {})
            resolve(
              new Response(new TextDecoder().decode(plaintext), {
                status: 200,
                headers: {
                  'Content-Type': 'application/json',
                  'X-Nodex-Seq': String(parsed.seq),
                },
              })
            )
          })
          .catch((err: unknown) => {
            console.warn('[SW] tryPeerFetch decrypt failed:', err)
            resolve(null)
          })
      } else {
        resolve(null)
      }
    }

    // Transfer port1 to the page; page replies on it, SW receives via port2.onmessage
    clients[0].postMessage({ type: 'P2P_FETCH', key }, [channel.port1])
  })
}

// ---------------------------------------------------------------------------
// fetchAndCache — network fetch + write via cache.ts + emit server-fallback metric
// ---------------------------------------------------------------------------

async function fetchAndCache(
  request: Request,
  key: string,
  start: number
): Promise<Response> {
  let response: Response

  try {
    response = await fetch(request.url, { mode: 'cors' })
  } catch (err) {
    console.error('[SW] Network fetch failed:', err)
    return new Response('Network error', { status: 502 })
  }

  if (!response.ok) {
    console.warn('[SW] Server returned non-ok status:', response.status, 'for', key)
    return response
  }

  // Guard: opaque responses cannot be read for X-Nodex-Seq — skip caching (T-02-02)
  if (response.type === 'opaque') {
    console.warn('[SW] Opaque response — skipping cache for:', key)
    return response
  }

  // Parse X-Nodex-Seq with NaN guard (T-02-01)
  const rawSeq = response.headers.get('X-Nodex-Seq')
  let seq = rawSeq ? parseInt(rawSeq, 10) : 1
  if (isNaN(seq) || seq < 1) {
    seq = 1
  }

  // Derive TTL from current volatility score and pass to putCachedEntry (CR-02)
  // putCachedEntry skips caching entirely when ttl_ms === 0 (ephemeral tier)
  const currentScore = scoreCache.get(key) ?? VOL_COLD_START
  const tier = classifyTier(currentScore)
  const ttl_ms = deriveTTL(tier)

  // Store in Cache Storage + IDB via cache.ts (handles LRU eviction, response.clone())
  await putCachedEntry(key, response, seq, ttl_ms)

  // Update in-memory seq map (self-seeding — D-09)
  updateSeq(key, seq)
  // Update obs_s barrier after server fetch — server version is authoritative
  observedVersionMap.set(key, observeVersion(observedVersionMap.get(key) ?? 0, seq))
  // Best-effort IDB persistence for monotonic read barrier (IMPL-02)
  // Sentinel pattern: __obs_v:{key} in nodex-meta store; seq = observed version
  getDb().then(db => db.put(META_STORE, {
    path: '__obs_v:' + key,
    seq: observedVersionMap.get(key) ?? 0,
    accessed_at: Date.now(),
    byte_size: 0,
  })).catch(() => {})

  // Emit server-fallback metric (D-14)
  const latency_ms = Math.round((self.performance.now() - start) * 100) / 100
  await emitMetric({ type: 'server-fallback', key, latency_ms })

  console.log('[SW] server-fallback cached:', key, 'seq=', seq)
  return decryptPayloadResponse(key, response, seq)
}
