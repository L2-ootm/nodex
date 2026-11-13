// src/server/mock-api.ts
// Hono mock API server — AES-GCM-256 encrypted product responses (Phase 3)
// Routes: GET /api/products/:id (encrypted ciphertext), GET /api/session-key,
//         POST /api/gossip-seed, POST /api/invalidate/:path, GET /api/__test__/seq/:path
// CORS: allows localhost:4173 (Playwright preview) and localhost:5173 (dev) for CORS-safe SW fetch()

import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { DEFAULT_SIGNALING_ROOM } from '../shared/config.js'
import { sessionKeyId } from './session-key.js'
import { snapshotEnvelope, renewalHeaders } from './snapshot-envelope.js'
import { canonicalSnapshot } from './sequence-authority.js'
import { getPublisher, publishProof, publishTime } from './publisher.js'
import { PROOF_HEADER, TIME_NONCE_PATTERN } from '../crypto/publisher-proof.js'
import { getPeers } from './signaling-server.js'
import { cloneSnapshot, MAX_SAFE_SEQUENCE } from './sequence-authority.js'
import { bodyLimit } from 'hono/body-limit'
import { validateBetaToken } from '../../api/lib/auth.js'
import nodePath from 'node:path'
import { pathToFileURL } from 'node:url'

const app = new Hono()
app.use('*', bodyLimit({ maxSize: 70_000 }))

// CORS must be applied BEFORE route handlers (Pitfall 7 — critical blocker if missed)
// Opaque responses make response.headers.get('X-Nodex-Seq') return null, breaking the
// entire freshness system.
app.use('*', cors({ origin: ['http://localhost:4173', 'http://localhost:5173'] }))

// NX-07: Beta auth gate for product endpoint.
// Enforcement is opt-in via NODEX_BETA_ENFORCE_AUTH=true so local dev / Playwright tests are
// unaffected by default. Set this env var in production/hosted deployments before external sharing.
// WR-02: Use constant-time comparison via timingSafeEqual to avoid timing side-channel for
// token enumeration. Both sides are SHA-256 hashed to normalize length before comparison.
function isBetaTokenValid(token: string | undefined): boolean {
  if (!token) return false
  const raw = process.env['NODEX_BETA_TOKENS'] ?? ''
  const valid = raw.split(',').map(t => t.trim()).filter(Boolean)
  const tokenHash = createHash('sha256').update(token).digest()
  return valid.some(v => {
    const vHash = createHash('sha256').update(v).digest()
    return timingSafeEqual(tokenHash, vHash)
  })
}

function betaAuthEnforced(): boolean {
  return process.env['NODEX_BETA_ENFORCE_AUTH'] === 'true'
}

function testFaultsEnabled(): boolean {
  return process.env['NODE_ENV'] !== 'production' &&
    process.env['NODEX_ENABLE_TEST_FAULTS'] === 'true'
}

// In-memory sequence counter — exported for test access (per D-10 and CONTEXT.md specifics)
export const seqCounters = new Map<string, number>()
const seqUpdatedAt = new Map<string, number>()
export const snapshots = new Map<string, Record<string, unknown>>()

// AES-GCM-256 key initialization — generated once per server startup
let encryptionKey: CryptoKey
export let sessionKeyBytes: Uint8Array = new Uint8Array(0)
let encryptionKeyId = ''

const cryptoReady: Promise<void> = (async () => {
  const rawKey = await globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  )
  const exported = await globalThis.crypto.subtle.exportKey('raw', rawKey)
  sessionKeyBytes = new Uint8Array(exported)
  encryptionKeyId = sessionKeyId(sessionKeyBytes)
  encryptionKey = await globalThis.crypto.subtle.importKey(
    'raw',
    Uint8Array.from(sessionKeyBytes).buffer,
    { name: 'AES-GCM' },
    true,
    ['encrypt', 'decrypt']
  )
})()

app.get('/api/publisher-key', async c => {
  c.header('Cache-Control', 'no-store')
  try { return c.json((await getPublisher()).identity) }
  catch { return c.json({ error: 'publisher unavailable' }, 503) }
})

// GET /api/products/:id — AES-GCM-256 encrypted product payload (CRPT-01)
// Body: base64 ciphertext. Headers: X-Nodex-Iv (base64, 12 bytes), X-Nodex-Key-Id, X-Nodex-Seq
// The IV is deterministic per (resource, version, plaintext) under an HKDF subkey, so the proof
// route below can renew freshness for ciphertext a reader already holds (see snapshot-seal.ts).
// Auth: requires Authorization: Bearer <token> when NODEX_BETA_ENFORCE_AUTH=true (NX-07)
async function resolveProduct(c: Context) {
  if (betaAuthEnforced()) {
    if (!await validateBetaToken(c.req.raw, 'tester')) {
      return { response: c.json({ error: 'Unauthorized' }, 401) }
    }
  }

  const id = c.req.param('id') as string
  const path = `/api/products/${id}`
  if (!seqCounters.has(path)) {
    snapshots.delete(path)
    seqCounters.set(path, 1)
    seqUpdatedAt.set(path, Date.now())
  }
  const currentSeq = seqCounters.get(path)!
  // Fault injection is opt-in even outside production. NODE_ENV is frequently
  // unset in previews, so it is not a sufficient security boundary.
  const injectedSeq = testFaultsEnabled()
    ? Number(c.req.header('X-Nodex-Test-Seq') ?? c.req.query('__nodex_test_seq'))
    : Number.NaN
  const seq = Number.isSafeInteger(injectedSeq) && injectedSeq > 0
    ? injectedSeq
    : currentSeq
  const updatedAt = seqUpdatedAt.get(path) ?? Date.now()

  await cryptoReady

  const payload = snapshots.get(path) ?? { id, name: `Product ${id}`, price: 9.99 }
  const scope = betaAuthEnforced() ? 'private' as const : 'public' as const
  const env = await snapshotEnvelope({ path, seq, payload, keyBytes: sessionKeyBytes, keyId: encryptionKeyId, scope })
  return { path, seq, updatedAt, scope, env, jsonBody: canonicalSnapshot(payload) }
}

app.get('/api/products/:id', async (c) => {
  const r = await resolveProduct(c)
  if (!r.env) return r.response
  const contentHash = createHash('sha256').update(r.jsonBody).digest('hex')
  const priv = r.scope === 'private'
  return c.body(r.env.ciphertext, 200, {
    'Content-Type': 'text/plain',
    'Cache-Control': priv ? 'private, no-store' : 'no-cache',
    [PROOF_HEADER]: r.env.proof,
    'X-Nodex-Cache-Scope': r.scope,
    'X-Nodex-Seq': String(r.seq),
    'X-Nodex-Iv': r.env.iv,
    'X-Nodex-Key-Id': encryptionKeyId,
    'X-Nodex-Version': String(r.seq),
    'X-Nodex-Updated-At': String(r.updatedAt),
    'X-Nodex-Validated-At': String(r.env.validatedAt),
    'X-Nodex-Policy': 'bounded-staleness',
    'X-Nodex-Max-Stale-Versions': '2',
    'X-Nodex-Max-Stale-Ms': '5000',
    'X-Nodex-Content-Hash': 'sha256:' + contentHash,
    'X-Nodex-Etag': '"v' + String(r.seq) + '"',
  })
})

// GET /api/time?nonce=… — signed server time bound to the caller's nonce (clock anchoring)
app.get('/api/time', async (c) => {
  const nonce = c.req.query('nonce') ?? ''
  if (!TIME_NONCE_PATTERN.test(nonce)) return c.json({ error: 'invalid nonce' }, 400)
  return c.json(await publishTime(nonce), 200, { 'Cache-Control': 'no-store' })
})

// GET /api/products/:id/proof — small signed renewal for a ciphertext the reader already holds
app.get('/api/products/:id/proof', async (c) => {
  const r = await resolveProduct(c)
  if (!r.env) return r.response
  return c.body(null, 204, renewalHeaders(r.env, r.seq, encryptionKeyId))
})

// POST /api/invalidate/:path{.+$} — bumps sequence counter for the given path
// Reconstructs path as '/' + param to normalize to '/api/products/1' form
app.post('/api/invalidate/:path{.+$}', async (c) => {
  if ((process.env['NODE_ENV'] === 'production' || betaAuthEnforced()) && !await validateBetaToken(c.req.raw, 'admin')) return c.json({ error: 'unauthorized' }, 401)
  const suffix = '/' + c.req.param('path')
  const path = suffix.startsWith('/api/') ? suffix : '/api' + suffix
  const current = seqCounters.get(path) ?? 1
  if (current === MAX_SAFE_SEQUENCE) return c.json({ error: 'sequence exhausted' }, 503)
  const newSeq = current + 1
  seqCounters.set(path, newSeq)
  seqUpdatedAt.set(path, Date.now())
  return c.json({ path, newSeq, seq: newSeq, invalidation: 'local-simulation' })
})

// POST /api/write/:path{.+$} — OCC write endpoint (IMPL-03)
// Accepts a write if baseVersion matches current seq; rejects with 409 if stale.
// PoC: unauthenticated — same risk posture as /api/invalidate (T-19-06)
//
// WR-01 ordering note: seqCounters defaults to 1 for unknown keys (write-before-read ordering).
// If a write arrives before any GET for a key, seqCounters initializes at 1 and advances to 2.
// The subsequent GET will read seq=2 from seqCounters (already set by the write).
// Tests that assume version history starts at 1 (e.g. buildPayloadAad(path, 1, ...)) must issue
// a GET before any write, or reset seqCounters in beforeEach to avoid decryption failures.
app.post('/api/write/:path{.+$}', async (c) => {
  if ((process.env['NODE_ENV'] === 'production' || betaAuthEnforced()) && !await validateBetaToken(c.req.raw, 'admin')) return c.json({ error: 'unauthorized' }, 401)
  const path = '/' + c.req.param('path')
  let body: { baseVersion?: unknown; data?: unknown }
  try {
    body = await c.req.json() as { baseVersion?: unknown; data?: unknown }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  if (!body || typeof body !== 'object' || !Number.isSafeInteger(body.baseVersion) || Number(body.baseVersion) < 1) return c.json({ error: 'baseVersion required' }, 400)
  let payload: Record<string, unknown>
  try { payload = cloneSnapshot(body.data) } catch { return c.json({ error: 'invalid snapshot data' }, 400) }
  const currentVersion = seqCounters.get(path) ?? 1
  if (currentVersion !== body.baseVersion) {
    return c.json({ error: 'conflict', currentVersion, baseVersion: body.baseVersion }, 409)
  }
  if (currentVersion === MAX_SAFE_SEQUENCE) return c.json({ error: 'sequence exhausted' }, 503)
  snapshots.set(path, payload)
  seqCounters.set(path, currentVersion + 1)
  seqUpdatedAt.set(path, Date.now())
  return c.json({ version: currentVersion + 1, path }, 200)
})

// GET /api/__test__/seq/:path{.+$} — test introspection endpoint
app.get('/api/__test__/seq/:path{.+$}', (c) => {
  if (!testFaultsEnabled()) return c.notFound()
  const path = '/' + c.req.param('path')
  const seq = seqCounters.get(path) ?? 1
  return c.json({ path, seq })
})

// GET /api/session-key — returns AES-GCM session key for SW decryption (CRPT-02)
// PoC: unauthenticated. Production: requires session token before key delivery (T-03-05)
app.get('/api/session-key', async (c) => {
  await cryptoReady
  return c.json({
    keyId: encryptionKeyId,
    keyBytes: Buffer.from(sessionKeyBytes).toString('base64'),
  }, 200)
})

// POST /api/gossip-seed — trigger gossip invalidation to up to 2 connected peers (GOSP-01)
// Body: { path: string, seq: number }. Returns { seededNodeIds: string[] }
// PoC: unauthenticated. Production: requires authenticated invalidation channel (T-03-01)
app.post('/api/gossip-seed', async (c) => {
  if ((process.env['NODE_ENV'] === 'production' || betaAuthEnforced()) && !await validateBetaToken(c.req.raw, 'admin')) return c.json({ error: 'unauthorized' }, 401)
  let body: { path?: string; seq?: number; room?: string }
  try {
    body = await c.req.json() as { path?: string; seq?: number; room?: string }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'invalid publication' }, 400)
  const { path, seq, room } = body
  if (!path || !/^\/api\/products\/[a-zA-Z0-9_-]{1,240}$/.test(path) || !Number.isSafeInteger(seq) || Number(seq) < 1) return c.json({ error: 'path and seq required' }, 400)
  const roomId = room ?? c.req.header('X-Nodex-Room') ?? c.req.query('room') ?? DEFAULT_SIGNALING_ROOM
  if (process.env['NODE_ENV'] !== 'test') {
    const endpoint = process.env['NODEX_BETA_SIGNALING_HTTP_URL'] ?? 'http://127.0.0.1:3002'
    const proof = seq === (seqCounters.get(path) ?? 1) ? await publishProof({
      kind: 'invalidation', resource: path, version: Number(seq), validatedAt: Date.now(),
    }) : undefined
    try {
      const upstream = await fetch(new URL('/gossip-seed', endpoint), { method: 'POST',
        headers: { 'Content-Type': 'application/json',
          ...(process.env['NODEX_SIGNALING_SEED_TOKEN'] ? { Authorization: `Bearer ${process.env['NODEX_SIGNALING_SEED_TOKEN']}` } : {}) },
        body: JSON.stringify({ key: path, seq, room: roomId, proof, eventId: crypto.randomUUID(),
          tenantId: process.env['NODEX_TENANT_ID'] }), signal: AbortSignal.timeout(3000) })
      if (!upstream.ok) return c.json({ error: 'signaling seed unavailable' }, 503)
      return c.json(await upstream.json())
    } catch { return c.json({ error: 'signaling seed unavailable' }, 503) }
  }
  const signalingPeers = getPeers(roomId)
  const candidates = [...signalingPeers.entries()]
    .filter(([, peer]) => peer.readyState === 1 /* OPEN */)
    .slice(0, 2)
  const seededNodeIds: string[] = []
  const msg = JSON.stringify({
    type: 'GOSSIP_INVALIDATE',
    msgId: globalThis.crypto.randomUUID(),
    key: path,
    seq,
    ttl: 5,
    originNodeId: 'server',
    t_invalidate: Date.now(),
  })
  for (const [peerId, peer] of candidates) {
    try {
      if (peer.readyState === 1 /* OPEN */) {
        peer.send(msg)
        seededNodeIds.push(peerId)
      }
    } catch (err) {
      console.warn(`[gossip-seed] send to ${peerId} failed (connection may have closed):`, err)
    }
  }
  return c.json({ seededNodeIds }, 200)
})

if (process.argv[1] && import.meta.url === pathToFileURL(nodePath.resolve(process.argv[1])).href) {
  if (process.env['NODE_ENV'] === 'production') throw new Error('Mock API is development-only; production uses api/ handlers')
  serve({ fetch: app.fetch, port: Number(process.env['NODEX_API_PORT'] ?? 3001), hostname: '127.0.0.1' }, (info) => {
    console.log(`[Nodex Mock API] Listening on http://localhost:${info.port}`)
  })
}

export { app }
