// src/server/mock-api.ts
// Hono mock API server — AES-GCM-256 encrypted product responses (Phase 3)
// Routes: GET /api/products/:id (encrypted ciphertext), GET /api/session-key,
//         POST /api/gossip-seed, POST /api/invalidate/:path, GET /api/__test__/seq/:path
// CORS: allows localhost:4173 (Playwright preview) and localhost:5173 (dev) for CORS-safe SW fetch()

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { ENCRYPTION_KEY_ID } from '../shared/config.js'
import { peers as signalingPeers } from './signaling-server.js'

const app = new Hono()

// CORS must be applied BEFORE route handlers (Pitfall 7 — critical blocker if missed)
// Opaque responses make response.headers.get('X-Nodex-Seq') return null, breaking the
// entire freshness system.
app.use('*', cors({ origin: ['http://localhost:4173', 'http://localhost:5173'] }))

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
app.get('/api/products/:id', async (c) => {
  const id = c.req.param('id')
  const path = `/api/products/${id}`
  if (!seqCounters.has(path)) {
    seqCounters.set(path, 1)
  }
  const seq = seqCounters.get(path)!

  await cryptoReady

  const jsonBody = JSON.stringify({ id, name: `Product ${id}`, price: 9.99 })
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
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
  const { path, seq } = await c.req.json() as { path: string; seq: number }
  const peerIds = [...signalingPeers.keys()].slice(0, 2)
  for (const peerId of peerIds) {
    const peer = signalingPeers.get(peerId)
    if (peer && peer.readyState === 1 /* OPEN */) {
      peer.send(JSON.stringify({
        type: 'GOSSIP_INVALIDATE',
        msgId: globalThis.crypto.randomUUID(),
        key: path,
        seq,
        ttl: 5,
        originNodeId: 'server',
        t_invalidate: Date.now(),
      }))
    }
  }
  return c.json({ seededNodeIds: peerIds }, 200)
})

if (process.env['NODE_ENV'] !== 'test') {
  serve({ fetch: app.fetch, port: 3001 }, (info) => {
    console.log(`[Nodex Mock API] Listening on http://localhost:${info.port}`)
  })
}

export { app }
