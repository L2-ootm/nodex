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
import { seedSeqMap, updateSeq, isFresh } from './freshness.js'
import { getCachedEntry, putCachedEntry, touchAccessedAt } from './cache.js'
import { emitMetric, flushBuffer, getNodeId } from './metrics.js'
import {
  CACHE_URL_PREFIX,
  META_STORE,
  P2P_FETCH_TIMEOUT_MS,
} from '../shared/config.js'
import type { CacheMeta } from '../shared/types.js'

declare const self: ServiceWorkerGlobalScope

const SW_VERSION = '1.0.0'

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
  } catch (err) {
    // IDB unavailable — safe to continue; seqMap stays empty (all entries treated as fresh)
    console.warn('[SW] IDB seed failed:', err)
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
    event.waitUntil(
      getNodeId().then((nodeId) => {
        ;(event.source as Client)?.postMessage({ type: 'NODE_ID', nodeId })
      })
    )
  }
})

// ---------------------------------------------------------------------------
// Fetch — intercept GET /api/* requests; everything else passes through
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event: FetchEvent) => {
  const { request } = event

  // Only intercept GET requests to the /api/ prefix (D-05, D-08)
  if (request.method !== 'GET' || !request.url.includes(CACHE_URL_PREFIX)) {
    // Non-/api/ or non-GET: fall through to the network (no respondWith call)
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
  const cached = await getCachedEntry(key)

  if (cached) {
    const { response, meta } = cached
    const cachedSeq = meta.seq

    if (isFresh(key, cachedSeq)) {
      // Fresh cache hit — update LRU timestamp (best-effort)
      await touchAccessedAt(key)

      // Emit sw-cache metric (D-14)
      const latency_ms = Math.round((self.performance.now() - start) * 100) / 100
      await emitMetric({ type: 'sw-cache', key, latency_ms })

      console.log('[SW] cache-hit (fresh):', key)
      return response
    }

    // Stale: cached seq is behind the latest known seq — fall through to server fetch
    console.log('[SW] cache-stale, fetching from server:', key, 'cachedSeq=', cachedSeq)
  } else {
    console.log('[SW] cache-miss, fetching from server:', key)
  }

  // --- P2P peer fetch (200ms race timeout, PEER-06) ---
  const peerResponse = await tryPeerFetch(key)
  if (peerResponse) {
    const latency_ms = Math.round((self.performance.now() - start) * 100) / 100
    await emitMetric({ type: 'peer-fetch', key, latency_ms })
    return peerResponse
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

    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timeout)
      if (
        event.data?.type === 'P2P_FETCH_RESPONSE' &&
        event.data.found &&
        event.data.payload
      ) {
        resolve(
          new Response(event.data.payload, {
            status: 200,
            headers: { 'X-Nodex-Seq': String(event.data.seq ?? 0) },
          })
        )
      } else {
        resolve(null)
      }
    }

    // Transfer port1 to the page client so it can reply on it
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

  // Store in Cache Storage + IDB via cache.ts (handles LRU eviction, response.clone())
  await putCachedEntry(key, response, seq)

  // Update in-memory seq map (self-seeding — D-09)
  updateSeq(key, seq)

  // Emit server-fallback metric (D-14)
  const latency_ms = Math.round((self.performance.now() - start) * 100) / 100
  await emitMetric({ type: 'server-fallback', key, latency_ms })

  console.log('[SW] server-fallback cached:', key, 'seq=', seq)
  return response
}
