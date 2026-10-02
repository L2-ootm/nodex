import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { cors } from 'hono/cors'
import { put, get } from '@vercel/blob'
import { configuredSessionKey } from '../../src/server/session-key.js'
import { buildPayloadAad } from '../../src/crypto/crypto.js'
import { getSequenceAuthority } from '../../src/server/sequence-authority-provider.js'
import { publishProof } from '../../src/server/publisher.js'
import { PROOF_HEADER } from '../../src/crypto/publisher-proof.js'
import type { SequenceRecord } from '../../src/server/sequence-authority.js'

export const config = { runtime: 'nodejs' }

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function logCapture(path: string, seq: number, ivB64: string, ctSample: string): Promise<void> {
  if (!process.env['BLOB_READ_WRITE_TOKEN']) return
  const blobKey = 'nodex-beta/interceptor-captures.jsonl'
  let existing = ''
  try {
    const blob = await get(blobKey, { access: 'private', useCache: false })
    if (blob?.stream) existing = await new Response(blob.stream).text()
  } catch { /* not found */ }

  const lines = existing.split('\n').filter(Boolean).slice(-29)
  lines.push(JSON.stringify({
    path,
    seq,
    iv_b64: ivB64,
    ciphertext_sample_b64: ctSample,
    timestamp: new Date().toISOString(),
    note: 'AES-GCM-256 — auth tag rejects any tamper or key mismatch',
  }))

  await put(blobKey, lines.join('\n') + '\n', {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/x-ndjson',
  })
}

export const app = new Hono()
app.onError(() => new Response('Publisher unavailable', {
  status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' },
}))
app.use('*', cors({
  origin: '*',
  exposeHeaders: ['X-Nodex-Seq', 'X-Nodex-Iv', 'X-Nodex-Key-Id', 'X-Nodex-Updated-At', 'X-Nodex-Validated-At'],
}))

app.get('/api/products/:id', async (c) => {
  const id = c.req.param('id')
  if (!/^[a-zA-Z0-9_-]{1,240}$/.test(id)) return c.json({ error: 'invalid product id' }, 400)

  const path = `/api/products/${id}`
  let authority: SequenceRecord
  try {
    authority = await getSequenceAuthority().read(path)
  } catch {
    return c.body('Sequence authority unavailable', 503, {
      'Cache-Control': 'no-store',
      'Retry-After': '1',
    })
  }
  const { seq, updatedAt } = authority
  const validatedAt = Date.now()

  const { bytes: keyBytes, keyId } = configuredSessionKey()
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw', toArrayBuffer(keyBytes), { name: 'AES-GCM' }, false, ['encrypt']
  )

  const plaintext = JSON.stringify(authority.payload ?? { id, name: `Product ${id}`, price: 9.99, seq })
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const aad = buildPayloadAad(path, seq, keyId, validatedAt)

  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad) },
    cryptoKey,
    new TextEncoder().encode(plaintext)
  )

  const ivB64 = Buffer.from(iv).toString('base64')
  const ctB64 = Buffer.from(new Uint8Array(ciphertext)).toString('base64')
  const proof = await publishProof({ resource: path, version: seq, validatedAt,
    body: ctB64, iv: ivB64, encryptionKeyId: keyId })

  // Non-blocking capture log for interceptor panel
  void logCapture(path, seq, ivB64, ctB64.slice(0, 64))

  return c.body(ctB64, 200, {
    'Content-Type': 'text/plain',
    'Cache-Control': 'no-cache',
    [PROOF_HEADER]: proof,
    'X-Nodex-Cache-Scope': 'public',
    'X-Nodex-Seq': String(seq),
    'X-Nodex-Iv': ivB64,
    'X-Nodex-Key-Id': keyId,
    'X-Nodex-Updated-At': String(updatedAt),
    'X-Nodex-Validated-At': String(validatedAt),
  })
})

const handler = handle(app)
export const GET = handler
export const OPTIONS = handler
