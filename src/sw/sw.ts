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
//   - Invalid/missing authoritative versions fail closed
//   - Cache key = new URL(request.url).pathname (not full URL — D-06)
//
// STRIDE mitigations:
//   T-03-02: FLUSH_BUFFER handler validates message type before executing flush

/// <reference lib="webworker" />

import { getDb } from './idb.js'
import { seedSeqMap, updateSeq, isFresh, getLatestSeq } from './freshness.js'
import { getCachedEntry, putCachedEntry, touchAccessedAt, resetPublicCache } from './cache.js'
import { emitMetric, flushBuffer, getNodeId } from './metrics.js'
import { meteredFetch, controlSnapshot } from '../shared/control-meter.js'
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
} from '../shared/config.js'
import type { CacheMeta, VolatilityEntry } from '../shared/types.js'
import { buildPayloadAad, decrypt as aesDecode } from '../crypto/crypto.js'
import { decodeProof, verifyProof, PROOF_HEADER, type PublisherIdentity } from '../crypto/publisher-proof.js'
import { computeScore, classifyTier, deriveTTL, recordActivity } from '../volatility/volatility.js'
import {
  admitAuthoritativeMetadata,
  admitCandidate,
  observeVersion,
  type ConsistencyPolicy,
} from '../shared/consistency.js'

declare const self: ServiceWorkerGlobalScope

const SW_VERSION = '1.0.0'
const workerInstance = crypto.randomUUID()

// Session keys imported via IMPORT_SESSION_KEY postMessage (CRPT-02)
const sessionKeys = new Map<string, CryptoKey>()
const runtimeFlags = {
  disableP2P: false,
  disableCacheRead: false,
}

async function importSessionKey(keyId: string, keyBytes: string): Promise<void> {
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(keyId) || typeof keyBytes !== 'string' || keyBytes.length > 128) throw new Error('Invalid session key')
  const raw = Uint8Array.from(atob(keyBytes), (c) => c.charCodeAt(0))
  if (raw.byteLength !== 32) throw new Error('Invalid session key size')
  const cryptoKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt'])
  if (sessionKeys.size >= 4 && !sessionKeys.has(keyId)) sessionKeys.delete(sessionKeys.keys().next().value!)
  sessionKeys.set(keyId, cryptoKey)
}

async function ensureSessionKey(keyId: string): Promise<CryptoKey | null> {
  const existing = sessionKeys.get(keyId)
  if (existing) return existing

  // A worker process can restart without controllerchange. Authorized controlled
  // pages retain reader credentials; never persist their invitation in SW state.
  if (await recoverReaderKey(keyId)) return sessionKeys.get(keyId) ?? null

  try {
    const res = await meteredFetch('session-key', '/api/session-key', { mode: 'cors', signal: AbortSignal.timeout(2_000) })
    if (!res.ok) return null
    const data = await res.json() as { keyId: string; keyBytes: string }
    await importSessionKey(data.keyId, data.keyBytes)
    return sessionKeys.get(keyId) ?? null
  } catch (err) {
    console.warn('[SW] ensureSessionKey failed:', err)
    return null
  }
}

async function recoverReaderKey(keyId: string): Promise<boolean> {
  const clients = (await self.clients.matchAll({ type: 'window' })).slice(0, 32)
  if (!clients.length) return false
  return new Promise<boolean>(resolve => {
    const channels: MessageChannel[] = []
    let finished = false
    let remaining = clients.length
    const finish = (success: boolean) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      for (const channel of channels) { channel.port1.close(); channel.port2.close() }
      resolve(success)
    }
    const timer = setTimeout(() => finish(false), 1000)
    for (const client of clients) {
      const channel = new MessageChannel()
      channels.push(channel)
      channel.port1.onmessage = event => {
        if (finished) return
        channel.port1.onmessage = null
        const message = event.data
        if (message?.type === 'SESSION_KEY_RESPONSE' && message.keyId === keyId && typeof message.keyBytes === 'string') {
          void importSessionKey(keyId, message.keyBytes).then(() => finish(true), () => { if (--remaining === 0) finish(false) })
        } else if (--remaining === 0) finish(false)
      }
      try { client.postMessage({ type: 'GET_SESSION_KEY', keyId }, [channel.port2]) }
      catch { if (--remaining === 0) finish(false) }
    }
  })
}

async function decryptPayloadResponse(key: string, response: Response, seq: number): Promise<Response> {
  const iv = response.headers.get('X-Nodex-Iv')
  const keyId = response.headers.get('X-Nodex-Key-Id') ?? ENCRYPTION_KEY_ID
  const validatedAt = Number(response.headers.get('X-Nodex-Validated-At'))
  if (!Number.isSafeInteger(validatedAt) || validatedAt <= 0) {
    return new Response('Invalid authoritative freshness metadata', { status: 502 })
  }
  if (!iv) return new Response('Authenticated envelope required', { status: 502 })

  try {
    const ciphertext = await response.clone().text()
    const proof = decodeProof(response.headers.get(PROOF_HEADER))
    const identity = proof ? await publisherIdentity(proof.signingKeyId) : null
    if (!proof || !identity || proof.version !== seq || proof.validatedAt !== validatedAt ||
      proof.iv !== iv || proof.encryptionKeyId !== keyId ||
      !await verifyProof(proof, identity, key, 'content', ciphertext)) {
      return new Response('Publisher verification failed', { status: 502 })
    }
    const cryptoKey = await ensureSessionKey(keyId)
    if (!cryptoKey) return new Response('Decrypt key unavailable', { status: 502 })
    if (domainOf(identity) !== publisherDomain) return new Response('Publisher domain changed', { status: 503 })
    const ctBytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0))
    const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0))
    const plaintext = await aesDecode(ctBytes, ivBytes, cryptoKey, buildPayloadAad(key, seq, keyId, validatedAt))
    return new Response(new TextDecoder().decode(plaintext), {
      status: response.status,
      statusText: response.statusText,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store', // plaintext is never a second, unverified HTTP cache
        'X-Nodex-Seq': String(seq),
        'Content-Length': String(plaintext.byteLength),
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
    if (!isPublicPath(key)) throw new Error('Resource is not opted in')
    const res = await fetchAndCache(new Request(new URL(key, self.location.origin), { cache: 'no-store' }),
      key, self.performance.now(), false)
    if (res.ok) {
      const version = Number(res.headers.get('X-Nodex-Seq'))
      if (Number.isSafeInteger(version) && version > 0) {
        serverSeq = version
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
// Monotonic within the trusted authority epoch, restored on every worker boot.
const observedVersionMap = new Map<string, number>()
const publisherKeys = new Map<string, PublisherIdentity>()
let publisherDomain: string | undefined
let domainGeneration = 0
let identityFetch: Promise<PublisherIdentity | null> | undefined
function domainOf(identity: Pick<PublisherIdentity, 'tenant' | 'epoch'>): string { return JSON.stringify([identity.tenant, identity.epoch]) }
async function bindPublisher(identity: PublisherIdentity): Promise<void> {
  await boot()
  const domain = domainOf(identity)
  if (publisherDomain === domain) return
  if (!durableState) {
    domainGeneration++; publisherKeys.clear(); publisherDomain = domain
    observedVersionMap.clear(); seedSeqMap([])
    return // verified origin reads remain usable; reuse stays disabled
  }
  if (publisherDomain !== undefined) {
    domainGeneration++
    publisherDomain = undefined
    publisherKeys.clear()
    await Promise.all([...barrierWrites.values()])
    await resetPublicCache()
    const db = await getDb()
    for (const entry of await db.getAll(META_STORE)) {
      if (isPublicPath(entry.path) || entry.path.startsWith('__obs_v:') || entry.path.startsWith('__inv_v:')) {
        await db.delete(META_STORE, entry.path)
      }
    }
    observedVersionMap.clear(); seedSeqMap([]); hydratedKeys.clear(); scoreCache.clear(); hintRefresh.clear()
  }
  // First binding preserves legacy durable barriers; only a trusted domain
  // transition authorizes a reset, never a key supplied by a peer.
  const db = await getDb()
  await db.put(META_STORE, { path: '__publisher_domain', seq: 0, accessed_at: Date.now(), byte_size: 0, publisher_domain: domain })
  publisherDomain = domain
}
async function publisherIdentity(keyId: string): Promise<PublisherIdentity | null> {
  if (publisherKeys.has(keyId)) return publisherKeys.get(keyId)!
  try {
    identityFetch ??= (async () => {
      const response = await meteredFetch('publisher-key', '/api/publisher-key', { cache: 'no-store', signal: AbortSignal.timeout(2_000) })
      if (!response.ok) return null
      const identity = await response.json() as PublisherIdentity
      if (![identity.keyId, identity.tenant, identity.epoch].every(value => typeof value === 'string' && value.length > 0 && value.length <= 512) ||
        identity.publicJwk?.d || identity.publicJwk?.kty !== 'EC' || identity.publicJwk?.crv !== 'P-256') return null
      await crypto.subtle.importKey('jwk', identity.publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      await bindPublisher(identity)
      publisherKeys.clear(); publisherKeys.set(identity.keyId, identity)
      return identity
    })()
    const pending = identityFetch
    try { const identity = await pending; return identity?.keyId === keyId ? identity : null }
    finally { if (identityFetch === pending) identityFetch = undefined }
  } catch { return null }
}
let bootPromise: Promise<void> | undefined
function boot(): Promise<void> {
  return bootPromise ??= (async () => {
    const db = await getDb()
    const entries = await db.getAll(META_STORE)
    publisherDomain = entries.find(entry => entry.path === '__publisher_domain')?.publisher_domain
    seedSeqMap(entries.filter(entry => !entry.path.startsWith('__')))
    for (const entry of entries) {
      if (entry.path.startsWith('__obs_v:')) observedVersionMap.set(entry.path.slice(8), entry.seq)
      if (entry.path.startsWith('__inv_v:')) updateSeq(entry.path.slice(8), entry.seq)
    }
  })().catch(() => { /* Without durable state, only the origin may serve. */ durableState = false })
}
let durableState = true
const hintRefresh = new Map<string, number>()
const barrierWrites = new Map<string, Promise<void>>()
async function persistBarrier(key: string, prefix: '__obs_v:' | '__inv_v:'): Promise<void> {
  const generation = domainGeneration
  const id = prefix + key
  const write = (barrierWrites.get(id) ?? Promise.resolve()).then(async () => {
    const db = await getDb()
    if (generation !== domainGeneration) return
    const seq = prefix === '__obs_v:' ? observedVersionMap.get(key) ?? 0 : getLatestSeq(key)
    await db.put(META_STORE, { path: id, seq, accessed_at: Date.now(), byte_size: 0 })
  })
  const settled = write.catch(() => { durableState = false })
  barrierWrites.set(id, settled)
  await settled
  if (barrierWrites.get(id) === settled) barrierWrites.delete(id)
}

// Map volatility score to a ConsistencyPolicy for admitCandidate().
// score >= VOL_P2P_GATE entries are server-only (caught by VOL-05 gate before this runs).
// For admissible keys we use fresh-dynamic with conservative version staleness budget.
function peerReadsPolicyFromScore(score: number): ConsistencyPolicy {
  if (score >= VOL_P2P_GATE) {
    return { class: 'critical', peerReads: false }
  }
  return { class: 'fresh-dynamic', peerReads: true, maxStaleVersions: 2, maxStaleMs: 5000 }
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

  await boot()

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
    const cacheNames = await self.caches.keys()
    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith('nodex-') && name !== CACHE_NAME)
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
  } else if (type === 'CONTROL_SNAPSHOT') {
    const reply = event.ports[0]
    if (reply) {
      reply.postMessage({ ...controlSnapshot(Number(event.data.since) || 0), workerInstance })
      reply.close()
    }
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
    // CR-03: validate inputs before mutating cache state — prevents same-origin denial-of-cache
    if (typeof key !== 'string' || key.length === 0 || !Number.isInteger(seq) || seq < 1) {
      console.warn('[SW] GOSSIP_INVALIDATE: invalid key or seq, ignored', { key, seq })
      return
    }
    event.waitUntil(
      (async () => {
        await boot()
        const proof = decodeProof(event.data.proof ?? null)
        const identity = proof ? await publisherIdentity(proof.signingKeyId) : null
        if (!proof || proof.scope !== 'public' || proof.version !== seq || !identity || !await verifyProof(proof, identity, key, 'invalidation')) {
          // Unsigned gossip is only a rate-limited hint to consult our trusted origin.
          if (Date.now() - (hintRefresh.get(key) ?? 0) >= 1_000 && isPublicPath(key)) {
            if (hintRefresh.size >= 500 && !hintRefresh.has(key)) hintRefresh.delete(hintRefresh.keys().next().value!)
            hintRefresh.set(key, Date.now())
            await fetchAndCache(new Request(new URL(key, self.location.origin), { cache: 'no-store' }), key, self.performance.now(), false)
          }
          return
        }
        if (domainOf(proof) !== publisherDomain || seq <= getLatestSeq(key)) return
        updateSeq(key, seq)
        try {
          const cache = await caches.open(CACHE_NAME)
          await cache.delete(key)
        } catch (err) {
          console.warn('[SW] GOSSIP_INVALIDATE cache.delete error:', err)
        }
        try {
          const db = await getDb()
          await persistBarrier(key, '__inv_v:')
          await db.delete(META_STORE, key)
        } catch {
          // best-effort IDB delete
        }
        // Update volatility ledger on invalidation — refreshes scoreCache in-memory (VOL-05)
        try {
          const db = await getDb()
          const tx = db.transaction(VOLATILITY_STORE, 'readwrite')
          const entry = recordActivity(key, await tx.store.get(key), 'change')
          await tx.store.put(entry)
          await tx.done
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
    // CR-03: validate keyId before importing — prevents same-origin key injection attack
    if (typeof keyId !== 'string' || keyId.length === 0) {
      console.warn('[SW] IMPORT_SESSION_KEY: invalid keyId, ignored')
      return
    }
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
  } else if (type === 'EVICT_PUBLIC_KEY') {
    const key = event.data?.key as string
    const replyPort = event.ports[0]
    event.waitUntil((async () => {
      if (!isPublicPath(key)) { replyPort?.postMessage({ ok: false }); return }
      try {
        await (await caches.open(CACHE_NAME)).delete(key)
        await (await getDb()).delete(META_STORE, key)
        // Session barriers survive benchmark eviction.
        replyPort?.postMessage({ ok: true })
      } catch { replyPort?.postMessage({ ok: false }) }
    })())
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
          // Read the authenticated server-validation time from IDB for time-staleness enforcement.
          let validatedAt: number | undefined
          try {
            const db = await getDb()
            const meta = await db.get(META_STORE, key)
            if (Number.isFinite(meta?.validated_at) && (meta?.validated_at ?? 0) > 0) {
              validatedAt = meta?.validated_at
            }
          } catch {
            // A peer without trustworthy age metadata is not eligible to serve this entry.
          }
          if (validatedAt === undefined) {
            replyPort?.postMessage({ found: false })
            return
          }
          // Re-serve the encrypted payload as-is (server stores ciphertext; SW never decrypts for peer serve)
          replyPort?.postMessage({
            found: true,
            payload: JSON.stringify({ ciphertext: payload, iv, keyId, seq, validatedAt,
              proof: cached.headers.get(PROOF_HEADER) }),
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
    !isPublicPath(url.pathname)
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

function isPublicPath(path: string): boolean {
  // Initial integration is intentionally limited to public product snapshots.
  return /^\/api\/products\/[a-zA-Z0-9_-]+$/.test(path)
}
function shareableRequest(request: Request): boolean {
  const url = new URL(request.url)
  return durableState && isPublicPath(url.pathname) && !url.search &&
    !request.headers.has('Authorization') && !request.headers.has('Cookie') &&
    !['no-store', 'reload', 'no-cache'].includes(request.cache) &&
    !/no-store|no-cache/i.test(request.headers.get('Cache-Control') ?? '')
}
function shareableResponse(response: Response): boolean {
  const vary = (response.headers.get('Vary') ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  return response.headers.get('X-Nodex-Cache-Scope') === 'public' &&
    decodeProof(response.headers.get(PROOF_HEADER))?.scope === 'public' &&
    !/private|no-store/i.test(response.headers.get('Cache-Control') ?? '') &&
    !response.headers.has('Set-Cookie') &&
    vary.every(value => value === 'origin' || value === 'accept-encoding')
}
async function hydrateKey(key: string): Promise<void> {
  await boot()
  if (!durableState || hydratedKeys.has(key)) return
  try {
    const db = await getDb()
    for (const prefix of ['__obs_v:', '__inv_v:']) {
      const entry = await db.get(META_STORE, prefix + key)
      if (entry && Number.isSafeInteger(entry.seq) && entry.seq > 0) {
        if (prefix === '__obs_v:') observedVersionMap.set(key, observeVersion(observedVersionMap.get(key) ?? 0, entry.seq))
        updateSeq(key, entry.seq)
      }
    }
    hydratedKeys.add(key)
  } catch { durableState = false }
}
const hydratedKeys = new Set<string>()
function admitted(key: string, seq: number, validatedAt: number, peer: boolean): boolean {
  if (!isFresh(key, seq)) return false
  if (!peer) return seq >= (observedVersionMap.get(key) ?? 0)
  return admitCandidate({ candidate: { key, version: seq, updatedAt: validatedAt, class: 'fresh-dynamic' },
    policy: peerReadsPolicyFromScore(scoreCache.get(key) ?? VOL_COLD_START),
    sessionObservedVersion: observedVersionMap.get(key) ?? 0,
    latestKnownVersion: getLatestSeq(key), now: Date.now() }).admitted
}
async function acceptResponse(key: string, response: Response, start: number,
  source: 'sw-cache' | 'peer-fetch' | 'server-fallback', store: boolean, signal?: AbortSignal,
  requestId: string = crypto.randomUUID(),
  trackPublicVersion = true,
): Promise<Response | null> {
  const seq = Number(response.headers.get('X-Nodex-Seq'))
  const validatedAt = Number(response.headers.get('X-Nodex-Validated-At'))
  if (!Number.isSafeInteger(seq) || seq < 1 || !Number.isSafeInteger(validatedAt) || validatedAt < 1) return null
  const decoded = await decryptPayloadResponse(key, response, seq)
  if (!decoded.ok) return decoded
  const proof = decodeProof(response.headers.get(PROOF_HEADER))!
  const current = () => domainOf(proof) === publisherDomain
  const allowed = () => current() && !signal?.aborted && (!trackPublicVersion || admitted(key, seq, validatedAt, source !== 'server-fallback'))
  if (!allowed()) {
    if (current() && trackPublicVersion && source === 'server-fallback' && seq < (observedVersionMap.get(key) ?? 0)) {
      await emitMetric({ type: 'admission-rejected', key, latency_ms: self.performance.now() - start,
        rejection_reason: 'below-session-observed', rejection_source: 'server' })
    }
    return null
  }
  if (store && trackPublicVersion && shareableResponse(response)) {
    await putCachedEntry(key, response, seq, deriveTTL(classifyTier(scoreCache.get(key) ?? VOL_COLD_START)), validatedAt, current)
  }
  // All awaits can admit a newer concurrent value. Recheck at commit and delivery.
  if (!allowed()) return null
  if (trackPublicVersion) {
    updateSeq(key, seq)
    observedVersionMap.set(key, observeVersion(observedVersionMap.get(key) ?? 0, seq))
    await persistBarrier(key, '__obs_v:')
  }
  if (!allowed()) return null
  decoded.headers.set('X-Nodex-Request-Id', requestId)
  decoded.headers.set('X-Nodex-Source', source)
  decoded.headers.set('X-Nodex-Consistency', trackPublicVersion ? durableState ? 'public-monotonic-durable' : 'origin-only-volatile' : 'origin-verified')
  void (async () => {
    try {
      const db = await getDb()
      const tx = db.transaction(VOLATILITY_STORE, 'readwrite')
      const entry = recordActivity(key, await tx.store.get(key), 'read')
      await tx.store.put(entry)
      await tx.done
      scoreCache.set(key, computeScore(entry))
    } catch { /* Optimization history must not block delivery. */ }
  })()
  void emitMetric({ type: source, key, latency_ms: self.performance.now() - start,
    request_id: requestId, delivered_bytes: Number(decoded.headers.get('Content-Length')) })
  return decoded
}
async function handleRequest(request: Request): Promise<Response> {
  const key = new URL(request.url).pathname
  const start = self.performance.now()
  const requestId = crypto.randomUUID()
  const mode = request.headers.get('X-Nodex-Read-Mode')
  await hydrateKey(key)
  const shared = shareableRequest(request)
  const cached = shared && mode !== 'origin' && mode !== 'peer' && !runtimeFlags.disableCacheRead ? await getCachedEntry(key) : null
  if (cached) {
    const accepted = await acceptResponse(key, cached.response, start, 'sw-cache', false, undefined, requestId)
    if (accepted?.ok) {
      void touchAccessedAt(key)
      return accepted
    }
    // Invalid cached content must not trap the user in repeated local failures.
  }
  if (shared && mode !== 'origin' && mode !== 'cache' && !runtimeFlags.disableP2P && (scoreCache.get(key) ?? VOL_COLD_START) < VOL_P2P_GATE) {
    const peer = await tryPeerFetch(key, start, requestId)
    if (peer) return peer
  }
  return fetchAndCache(request, key, start, shared && mode !== 'origin', requestId)
}
async function tryPeerFetch(key: string, start: number, requestId: string): Promise<Response | null> {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: false })
  if (!clients.length) return null
  return new Promise(resolve => {
    const abort = new AbortController()
    const channels: MessageChannel[] = []
    let finished = false
    const finish = (response: Response | null) => {
      if (finished) return
      finished = true
      abort.abort()
      clearTimeout(timer)
      for (const channel of channels) { channel.port1.close(); channel.port2.close() }
      resolve(response)
    }
    const timer = setTimeout(() => finish(null), P2P_FETCH_TIMEOUT_MS)
    // Followers may answer not-found; wait for the leader or the full deadline.
    for (const client of clients.slice(0, 16)) {
      const channel = new MessageChannel()
      channels.push(channel)
      channel.port2.onmessage = async event => {
        if (finished || event.data?.type !== 'P2P_FETCH_RESPONSE' || !event.data.found ||
          typeof event.data.payload !== 'string' || event.data.payload.length > 2 * 1024 * 1024) return
        try {
          const p = JSON.parse(event.data.payload) as Record<string, unknown>
          if (![p.ciphertext, p.iv, p.keyId, p.proof].every(value => typeof value === 'string')) return
          if (!Number.isSafeInteger(p.seq) || !Number.isSafeInteger(p.validatedAt)) return
          if (decodeProof(p.proof as string)?.scope !== 'public') return
          const candidate = new Response(p.ciphertext as string, { headers: {
            'Content-Type': 'text/plain', 'X-Nodex-Seq': String(p.seq),
            'X-Nodex-Validated-At': String(p.validatedAt), 'X-Nodex-Iv': p.iv as string,
            'X-Nodex-Key-Id': p.keyId as string, [PROOF_HEADER]: p.proof as string,
            'X-Nodex-Cache-Scope': 'public',
          } })
          const accepted = await acceptResponse(key, candidate, start, 'peer-fetch', true, abort.signal, requestId)
          if (accepted?.ok && !finished) finish(accepted)
        } catch { /* Invalid/unavailable peers leave the origin fallback available. */ }
      }
      try { client.postMessage({ type: 'P2P_FETCH', key }, [channel.port1]) }
      catch { /* Another tab may have closed between discovery and dispatch. */ }
    }
  })
}
async function fetchAndCache(request: Request, key: string, start: number, store = false, requestId: string = crypto.randomUUID()): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response
    try {
      response = await fetch(new Request(request, {
        ...(attempt ? { cache: 'no-store' } : {}), signal: AbortSignal.timeout(5_000),
      }))
    } catch { return new Response('Origin unavailable', { status: 502 }) }
    if (!response.ok) return response
    if (response.type === 'opaque') return new Response('Authoritative version unavailable', { status: 503 })
    const metadata = admitAuthoritativeMetadata(response.headers.get('X-Nodex-Seq'),
      response.headers.get('X-Nodex-Validated-At'), 0)
    if (metadata.admitted) {
      const url = new URL(request.url)
      const canonical = !url.search && !request.headers.has('Authorization') && !request.headers.has('Cookie') && shareableResponse(response)
      const accepted = await acceptResponse(key, response, start, 'server-fallback', store, undefined, requestId, canonical)
      if (accepted) return accepted
    } else {
      await emitMetric({ type: 'admission-rejected', key, latency_ms: self.performance.now() - start,
        rejection_reason: metadata.reason, rejection_source: 'server' })
    }
  }
  return new Response('Fresh authoritative version unavailable', { status: 503,
    headers: { 'Retry-After': '1', 'X-Nodex-Min-Version': String(observedVersionMap.get(key) ?? 0) } })
}
