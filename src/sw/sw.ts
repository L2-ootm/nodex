// src/sw/sw.ts — Service Worker entry point
// Phase 1: install/activate lifecycle, fetch event interception,
// cache hit/miss/fallback with seq-number freshness validation.
//
// Critical constraints (see RESEARCH.md Anti-Patterns, Pitfall 1, Pitfall 4):
//   - event.respondWith() MUST be called synchronously (no await before it)
//   - Always response.clone() before cache.put(); return the original
//   - IDB writes wrapped in try/catch; QuotaExceededError must NOT crash the SW
//   - Guard opaque responses: skip cache.put() if response.type === 'opaque'
//   - NaN guard on X-Nodex-Seq; fallback to seq=1
//   - Cache key = new URL(request.url).pathname (not full URL — D-06)

/// <reference lib="webworker" />

import { getDb } from './idb.js'
import { seedSeqMap, updateSeq, isFresh } from './freshness.js'
import {
  CACHE_NAME,
  CACHE_URL_PREFIX,
  META_STORE,
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
// Activate — claim clients, init IDB, seed in-memory seq map, prune old caches
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

  // Prune caches from older SW versions (any cache name that is not CACHE_NAME)
  try {
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
// handleRequest — cache hit/miss/stale logic with IDB metadata writes
// ---------------------------------------------------------------------------

async function handleRequest(request: Request): Promise<Response> {
  const key = new URL(request.url).pathname  // D-06: cache key = pathname only
  const cache = await self.caches.open(CACHE_NAME)

  // --- Cache lookup ---
  const cached = await cache.match(key)

  if (cached) {
    // Read IDB meta to get the stored seq for freshness check
    let meta: CacheMeta | undefined
    try {
      const db = await getDb()
      meta = await db.get(META_STORE, key)
    } catch (err) {
      console.warn('[SW] IDB meta read failed, treating as stale:', err)
    }

    const cachedSeq = meta?.seq ?? 1

    if (isFresh(key, cachedSeq)) {
      // Fresh cache hit — update accessed_at in IDB (best-effort, non-blocking)
      try {
        const db = await getDb()
        if (meta) {
          await db.put(META_STORE, { ...meta, accessed_at: Date.now() })
        }
      } catch (err) {
        // QuotaExceededError or other IDB failure — silently skip (T-02-03)
        console.warn('[SW] IDB accessed_at update failed:', err)
      }
      // Metrics stub: full metrics harness in Plan 03
      console.log('[SW] cache-hit (fresh):', key)
      return cached
    }

    // Stale: cached seq is behind the latest known seq — fall through to server fetch
    console.log('[SW] cache-stale, fetching from server:', key, 'cachedSeq=', cachedSeq)
  } else {
    console.log('[SW] cache-miss, fetching from server:', key)
  }

  // --- Server fallback ---
  return fetchAndCache(request, key, cache)
}

// ---------------------------------------------------------------------------
// fetchAndCache — network fetch + write to Cache Storage + write IDB meta
// ---------------------------------------------------------------------------

async function fetchAndCache(
  request: Request,
  key: string,
  cache: Cache
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

  // CRITICAL: clone before cache.put(); return the original to the page
  const responseToCache = response.clone()

  // Parse X-Nodex-Seq with NaN guard (T-02-01)
  const rawSeq = response.headers.get('X-Nodex-Seq')
  let seq = rawSeq ? parseInt(rawSeq, 10) : 1
  if (isNaN(seq) || seq < 1) {
    seq = 1
  }

  // Estimate byte size from Content-Length (fallback 500 — actual tracking in Plan 03)
  const rawLen = response.headers.get('content-length')
  const byteSize = rawLen ? (parseInt(rawLen, 10) || 500) : 500

  // Write response to Cache Storage
  try {
    await cache.put(key, responseToCache)
  } catch (err) {
    console.warn('[SW] Cache put failed:', err)
    // Return the original response even if caching fails
    return response
  }

  // Write IDB metadata (T-02-03: wrap in try/catch — QuotaExceededError must not crash SW)
  try {
    const db = await getDb()
    const meta: CacheMeta = {
      path: key,
      seq,
      accessed_at: Date.now(),
      byte_size: byteSize,
    }
    await db.put(META_STORE, meta)
  } catch (err) {
    // IDB write failure (QuotaExceededError etc.) — log, skip IDB write, return response
    console.warn('[SW] IDB meta write failed (QuotaExceededError?):', err)
  }

  // Update in-memory seq map (self-seeding — D-09)
  updateSeq(key, seq)

  console.log('[SW] server-fallback cached:', key, 'seq=', seq)
  return response
}
