// src/sw/cache.ts — LRU cache helpers for the Service Worker
// D-11: 30MB hard cap; D-12: LRU by accessed_at timestamp
//
// CRITICAL (RESEARCH.md Anti-Patterns):
//   - Always response.clone() before cache.put(); return the original to the caller
//   - Never cache opaque responses (response.type === 'opaque')
//   - evictIfNeeded is a pure function (receives allMeta as param) — no browser APIs
//   - IDB writes wrapped in try/catch; QuotaExceededError must NOT crash the SW

/// <reference lib="webworker" />

import { getDb } from './idb.js'
import {
  CACHE_NAME,
  CACHE_MAX_BYTES,
  META_STORE,
} from '../shared/config.js'
import type { CacheMeta } from '../shared/types.js'

declare const self: ServiceWorkerGlobalScope

// ---------------------------------------------------------------------------
// evictIfNeeded — PURE FUNCTION (no browser APIs — fully testable under vitest)
// ---------------------------------------------------------------------------

/**
 * Determine which cache entry to evict, if any.
 *
 * @param allMeta   All current CacheMeta entries (read from IDB by caller)
 * @param newByteSize  Byte size of the entry about to be written
 * @returns path of the entry to evict, or null if no eviction is needed
 *
 * Logic (D-11, D-12):
 *   1. Filter out internal sentinel entries (path starts with '__')
 *   2. Sum byte_size of all entries
 *   3. If totalBytes + newByteSize >= CACHE_MAX_BYTES → sort by accessed_at ascending,
 *      return the first entry's path (oldest = LRU)
 *   4. Otherwise return null
 *
 * Stable sort: entries with identical accessed_at retain their insertion order
 * (Array.prototype.sort is stable in all modern engines).
 */
export function evictIfNeeded(allMeta: CacheMeta[], newByteSize: number): string | null {
  // Filter out sentinel entries (e.g. '__node_id') — these are not cache entries
  const cacheEntries = allMeta.filter((m) => !m.path.startsWith('__'))

  const totalBytes = cacheEntries.reduce((sum, m) => sum + m.byte_size, 0)

  if (totalBytes + newByteSize < CACHE_MAX_BYTES) {
    return null
  }

  // Sort by accessed_at ascending (oldest first) — stable sort preserves insertion order on ties
  const sorted = [...cacheEntries].sort((a, b) => a.accessed_at - b.accessed_at)

  return sorted.length > 0 ? sorted[0].path : null
}

export function isStorageQuotaPressure(err: unknown): boolean {
  const record = err as { name?: unknown; code?: unknown; message?: unknown }
  const name = typeof record?.name === 'string' ? record.name : ''
  const code = typeof record?.code === 'number' ? record.code : undefined
  const message = typeof record?.message === 'string' ? record.message.toLowerCase() : ''

  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    message.includes('quota')
  )
}

// ---------------------------------------------------------------------------
// getCachedEntry — read a matched entry from Cache Storage + IDB meta
// ---------------------------------------------------------------------------

/**
 * Look up a cache entry by key.
 * Returns both the Response and its CacheMeta, or null if either is missing.
 * Skip entries with path starting with '__' (sentinel entries are not cache entries).
 */
export async function getCachedEntry(
  key: string
): Promise<{ response: Response; meta: CacheMeta } | null> {
  if (key.startsWith('__')) return null

  let cachedResponse: Response | undefined
  try {
    const cache = await self.caches.open(CACHE_NAME)
    cachedResponse = await cache.match(key) ?? undefined
  } catch (err) {
    console.warn('[cache] Cache Storage match failed:', err)
    return null
  }

  if (!cachedResponse) return null

  let meta: CacheMeta | undefined
  try {
    const db = await getDb()
    meta = await db.get(META_STORE, key)
  } catch (err) {
    console.warn('[cache] IDB meta read failed:', err)
    return null
  }

  if (!meta) return null

  // TTL expiry check (CR-02): if ttl_ms is set and the entry has expired, treat as a miss
  if (meta.ttl_ms !== undefined && meta.cached_at !== undefined) {
    const age_ms = Date.now() - meta.cached_at
    if (age_ms >= meta.ttl_ms) {
      console.log('[cache] TTL expired for:', key, `age=${age_ms}ms ttl=${meta.ttl_ms}ms`)
      // Best-effort eviction of the expired entry
      try {
        const cache = await self.caches.open(CACHE_NAME)
        await cache.delete(key)
      } catch { /* best-effort */ }
      try {
        const db2 = await getDb()
        await db2.delete(META_STORE, key)
      } catch { /* best-effort */ }
      return null
    }
  }

  return { response: cachedResponse, meta }
}

// ---------------------------------------------------------------------------
// putCachedEntry — write response to Cache Storage + IDB meta, with LRU eviction
// ---------------------------------------------------------------------------

/**
 * Store a response in Cache Storage and write its metadata to IDB.
 * Runs LRU eviction before writing if the byte tally would exceed CACHE_MAX_BYTES.
 *
 * @param key      Cache key (pathname)
 * @param response The Response to store (will be cloned internally — caller retains original)
 * @param seq      The X-Nodex-Seq value from the response header
 * @param ttl_ms   Optional TTL in ms from deriveTTL; 0 = ephemeral (skip caching); absent = stable/no expiry
 */
export async function putCachedEntry(
  key: string,
  response: Response,
  seq: number,
  ttl_ms?: number
): Promise<void> {
  // Ephemeral keys (TTL = 0ms) must not be cached — skip write entirely (CR-02)
  if (ttl_ms === 0) {
    console.log('[cache] Skipping ephemeral key (ttl_ms=0):', key)
    return
  }
  if (key.startsWith('__')) return
  if (response.type === 'opaque') {
    console.warn('[cache] Skipping opaque response for:', key)
    return
  }

  // Estimate byte size from Content-Length; fall back to 500B
  const rawLen = response.headers.get('content-length')
  const byteSize = rawLen ? (parseInt(rawLen, 10) || 500) : 500

  // --- LRU eviction check ---
  let allMeta: CacheMeta[] = []
  try {
    const db = await getDb()
    allMeta = await db.getAll(META_STORE)
  } catch (err) {
    console.warn('[cache] IDB getAll failed, skipping eviction check:', err)
  }

  const evictPath = evictIfNeeded(allMeta, byteSize)

  if (evictPath) {
    console.log('[cache] LRU evicting:', evictPath)
    try {
      const cache = await self.caches.open(CACHE_NAME)
      await cache.delete(evictPath)
    } catch (err) {
      console.warn('[cache] Cache delete failed for eviction target:', evictPath, err)
    }
    try {
      const db = await getDb()
      await db.delete(META_STORE, evictPath)
    } catch (err) {
      console.warn('[cache] IDB delete failed for eviction target:', evictPath, err)
    }
  }

  // --- Write to Cache Storage ---
  try {
    const cache = await self.caches.open(CACHE_NAME)
    await cache.put(key, response.clone())
  } catch (err) {
    console.warn(isStorageQuotaPressure(err) ? '[cache] Cache put skipped due to quota pressure:' : '[cache] Cache put failed:', err)
    // Return even if caching fails — caller already has the original response
    return
  }

  // --- Write IDB metadata ---
  try {
    const db = await getDb()
    const now = Date.now()
    const meta: CacheMeta = {
      path: key,
      seq,
      accessed_at: now,
      byte_size: byteSize,
      ...(ttl_ms !== undefined ? { ttl_ms, cached_at: now } : {}),
    }
    await db.put(META_STORE, meta)
  } catch (err) {
    // QuotaExceededError or other IDB failure — log, do not propagate (T-02-03)
    console.warn(isStorageQuotaPressure(err) ? '[cache] IDB meta write skipped due to quota pressure:' : '[cache] IDB meta write failed:', err)
  }
}

// ---------------------------------------------------------------------------
// touchAccessedAt — update LRU timestamp on cache hit
// ---------------------------------------------------------------------------

/**
 * Update the accessed_at timestamp for a cache entry on hit.
 * Best-effort: IDB failures are logged and swallowed.
 */
export async function touchAccessedAt(key: string): Promise<void> {
  if (key.startsWith('__')) return
  try {
    const db = await getDb()
    const meta = await db.get(META_STORE, key)
    if (meta) {
      await db.put(META_STORE, { ...meta, accessed_at: Date.now() })
    }
  } catch (err) {
    console.warn('[cache] touchAccessedAt failed:', err)
  }
}
