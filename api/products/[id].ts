import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { cors } from 'hono/cors'
import { put, get } from '@vercel/blob'
import { ENCRYPTION_KEY_ID } from '../../src/shared/config.js'
import { buildPayloadAad } from '../../src/crypto/crypto.js'

export const config = { runtime: 'nodejs' }

function getSessionKeyBytes(): Uint8Array {
  const hex = process.env['NODEX_SESSION_KEY_HEX'] ?? ''
  if (/^[0-9a-f]{64}$/i.test(hex)) {
    return new Uint8Array(Buffer.from(hex, 'hex'))
  }
  // Dev fallback — deterministic 32-byte key, NOT production-secure
  const seed = 'nodex-dev-key-32bytes-padding!!!'
  return new TextEncoder().encode(seed.slice(0, 32))
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export class SequenceAuthorityUnavailableError extends Error {
  constructor() {
    super('sequence authority unavailable')
    this.name = 'SequenceAuthorityUnavailableError'
  }
}

export async function getSeq(path: string): Promise<{ seq: number; updatedAt: number }> {
  if (!process.env['BLOB_READ_WRITE_TOKEN']) throw new SequenceAuthorityUnavailableError()
  const blobKey = `nodex-seq/${path.replace(/\//g, '_')}.json`
  try {
    const blob = await get(blobKey, { access: 'private', useCache: false })
    if (!blob?.stream) throw new SequenceAuthorityUnavailableError()
    const text = await new Response(blob.stream).text()
    const data = JSON.parse(text) as { seq?: unknown; updatedAt?: unknown }
    if (
      !Number.isSafeInteger(data.seq) ||
      (data.seq as number) <= 0 ||
      !Number.isSafeInteger(data.updatedAt) ||
      (data.updatedAt as number) <= 0
    ) {
      throw new SequenceAuthorityUnavailableError()
    }
    return { seq: data.seq as number, updatedAt: data.updatedAt as number }
  } catch (error) {
    if (error instanceof SequenceAuthorityUnavailableError) throw error
    throw new SequenceAuthorityUnavailableError()
  }
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
app.use('*', cors({
  origin: '*',
  exposeHeaders: ['X-Nodex-Seq', 'X-Nodex-Iv', 'X-Nodex-Key-Id', 'X-Nodex-Updated-At', 'X-Nodex-Validated-At'],
}))

app.get('/api/products/:id', async (c) => {
  const id = c.req.param('id')
  if (!/^\d+$/.test(id)) return c.json({ error: 'invalid product id' }, 400)

  const path = `/api/products/${id}`
  let authority: { seq: number; updatedAt: number }
  try {
    authority = await getSeq(path)
  } catch (error) {
    if (error instanceof SequenceAuthorityUnavailableError) {
      return c.body('Sequence authority unavailable', 503, {
        'Cache-Control': 'no-store',
        'Retry-After': '1',
      })
    }
    throw error
  }
  const { seq, updatedAt } = authority
  const validatedAt = Date.now()

  const keyBytes = getSessionKeyBytes()
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw', toArrayBuffer(keyBytes), { name: 'AES-GCM' }, false, ['encrypt']
  )

  const plaintext = JSON.stringify({ id, name: `Product ${id}`, price: 9.99, seq })
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const aad = buildPayloadAad(path, seq, ENCRYPTION_KEY_ID, validatedAt)

  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad) },
    cryptoKey,
    new TextEncoder().encode(plaintext)
  )

  const ivB64 = Buffer.from(iv).toString('base64')
  const ctB64 = Buffer.from(new Uint8Array(ciphertext)).toString('base64')

  // Non-blocking capture log for interceptor panel
  void logCapture(path, seq, ivB64, ctB64.slice(0, 64))

  return c.body(ctB64, 200, {
    'Content-Type': 'text/plain',
    'X-Nodex-Seq': String(seq),
    'X-Nodex-Iv': ivB64,
    'X-Nodex-Key-Id': ENCRYPTION_KEY_ID,
    'X-Nodex-Updated-At': String(updatedAt),
    'X-Nodex-Validated-At': String(validatedAt),
  })
})

const handler = handle(app)
export const GET = handler
export const OPTIONS = handler
