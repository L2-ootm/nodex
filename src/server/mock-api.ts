// src/server/mock-api.ts
// Hono mock API server — AES-GCM-256 encrypted product responses (Phase 3)
// Routes: GET /api/products/:id (encrypted ciphertext), GET /api/session-key,
//         POST /api/gossip-seed, POST /api/invalidate/:path, GET /api/__test__/seq/:path
// CORS: allows localhost:4173 (Playwright preview) and localhost:5173 (dev) for CORS-safe SW fetch()

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { DEFAULT_SIGNALING_ROOM, ENCRYPTION_KEY_ID } from '../shared/config.js'
import { buildPayloadAad } from '../crypto/crypto.js'
import { getPeers } from './signaling-server.js'

const app = new Hono()

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

// In-memory sequence counter — exported for test access (per D-10 and CONTEXT.md specifics)
export const seqCounters = new Map<string, number>()

// AES-GCM-256 key initialization — generated once per server startup
let encryptionKey: CryptoKey
export let sessionKeyBytes: Uint8Array = new Uint8Array(0)

const cryptoReady: Promise<void> = (async () => {
  const rawKey = await globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  )
  const exported = await globalThis.crypto.subtle.exportKey('raw', rawKey)
  sessionKeyBytes = new Uint8Array(exported)
  encryptionKey = await globalThis.crypto.subtle.importKey(
    'raw',
    sessionKeyBytes,
    { name: 'AES-GCM' },
    true,
    ['encrypt', 'decrypt']
  )
})()

// GET /api/products/:id — AES-GCM-256 encrypted product payload (CRPT-01)
// Body: base64 ciphertext. Headers: X-Nodex-Iv (base64, 12 bytes), X-Nodex-Key-Id, X-Nodex-Seq
// Fresh IV per call via getRandomValues — mitigates IV-reuse (T-03-03)
// Auth: requires Authorization: Bearer <token> when NODEX_BETA_ENFORCE_AUTH=true (NX-07)
app.get('/api/products/:id', async (c) => {
  if (betaAuthEnforced()) {
    const authHeader = c.req.header('Authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined
    if (!isBetaTokenValid(token)) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
  }

  const id = c.req.param('id')
  const path = `/api/products/${id}`
  if (!seqCounters.has(path)) {
    seqCounters.set(path, 1)
  }
  const seq = seqCounters.get(path)!

  await cryptoReady

  const jsonBody = JSON.stringify({ id, name: `Product ${id}`, price: 9.99 })
  const contentHash = createHash('sha256').update(jsonBody).digest('hex')
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: buildPayloadAad(path, seq, ENCRYPTION_KEY_ID) },
    encryptionKey,
    new TextEncoder().encode(jsonBody)
  )
  const ivBase64 = Buffer.from(iv).toString('base64')
  const ctBase64 = Buffer.from(new Uint8Array(ciphertext)).toString('base64')

  return c.body(ctBase64, 200, {
    'Content-Type': 'text/plain',
    'X-Nodex-Seq': String(seq),
    'X-Nodex-Iv': ivBase64,
    'X-Nodex-Key-Id': ENCRYPTION_KEY_ID,
    'X-Nodex-Version': String(seq),
    'X-Nodex-Updated-At': String(Date.now()),
    'X-Nodex-Policy': 'bounded-staleness',
    'X-Nodex-Max-Stale-Versions': '2',
    'X-Nodex-Max-Stale-Ms': '5000',
    'X-Nodex-Content-Hash': 'sha256:' + contentHash,
    'X-Nodex-Etag': '"v' + String(seq) + '"',
  })
})

// POST /api/invalidate/:path{.+$} — bumps sequence counter for the given path
// Reconstructs path as '/' + param to normalize to '/api/products/1' form
app.post('/api/invalidate/:path{.+$}', (c) => {
  const path = '/' + c.req.param('path')
  const current = seqCounters.get(path) ?? 1
  const newSeq = current + 1
  seqCounters.set(path, newSeq)
  return c.json({ path, newSeq })
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
  const path = '/' + c.req.param('path')
  let body: { baseVersion?: unknown; data?: unknown }
  try {
    body = await c.req.json() as { baseVersion?: unknown; data?: unknown }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  if (typeof body.baseVersion !== 'number') return c.json({ error: 'baseVersion required' }, 400)
  const currentVersion = seqCounters.get(path) ?? 1
  if (currentVersion > body.baseVersion) {
    return c.json({ error: 'conflict', currentVersion, baseVersion: body.baseVersion }, 409)
  }
  seqCounters.set(path, currentVersion + 1)
  return c.json({ version: currentVersion + 1, path }, 200)
})

// GET /api/__test__/seq/:path{.+$} — test introspection endpoint
app.get('/api/__test__/seq/:path{.+$}', (c) => {
  const path = '/' + c.req.param('path')
  const seq = seqCounters.get(path) ?? 1
  return c.json({ path, seq })
})

// GET /api/session-key — returns AES-GCM session key for SW decryption (CRPT-02)
// PoC: unauthenticated. Production: requires session token before key delivery (T-03-05)
app.get('/api/session-key', async (c) => {
  await cryptoReady
  return c.json({
    keyId: ENCRYPTION_KEY_ID,
    keyBytes: Buffer.from(sessionKeyBytes).toString('base64'),
  }, 200)
})

// POST /api/gossip-seed — trigger gossip invalidation to up to 2 connected peers (GOSP-01)
// Body: { path: string, seq: number }. Returns { seededNodeIds: string[] }
// PoC: unauthenticated. Production: requires authenticated invalidation channel (T-03-01)
app.post('/api/gossip-seed', async (c) => {
  let body: { path?: string; seq?: number; room?: string }
  try {
    body = await c.req.json() as { path?: string; seq?: number; room?: string }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const { path, seq, room } = body
  if (!path || typeof seq !== 'number') return c.json({ error: 'path and seq required' }, 400)
  const roomId = room ?? c.req.header('X-Nodex-Room') ?? c.req.query('room') ?? DEFAULT_SIGNALING_ROOM
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

if (process.env['NODE_ENV'] !== 'test') {
  serve({ fetch: app.fetch, port: 3001 }, (info) => {
    console.log(`[Nodex Mock API] Listening on http://localhost:${info.port}`)
  })
}

export { app }
