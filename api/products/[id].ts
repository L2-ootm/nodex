import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { cors } from 'hono/cors'
import { put, get } from '@vercel/blob'
import { loadProductEnvelope } from '../lib/product-envelope.js'
import { PROOF_HEADER } from '../../src/crypto/publisher-proof.js'

export const config = { runtime: 'nodejs' }

async function logCapture(path: string, seq: number, ivB64: string, ctSample: string): Promise<void> {
  // Opt-in demo capture only: it costs a blob read and write per payload read.
  if (process.env['NODEX_INTERCEPTOR_CAPTURE'] !== '1' || !process.env['BLOB_READ_WRITE_TOKEN']) return
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
  exposeHeaders: ['X-Nodex-Seq', 'X-Nodex-Iv', 'X-Nodex-Key-Id', 'X-Nodex-Updated-At', 'X-Nodex-Validated-At', PROOF_HEADER],
}))

app.get('/api/products/:id', async (c) => {
  const loaded = await loadProductEnvelope(c.req.param('id'))
  if (!loaded.ok) {
    return loaded.status === 400 ? c.json({ error: loaded.body }, 400)
      : c.body(loaded.body, 503, { 'Cache-Control': 'no-store', 'Retry-After': '1' })
  }
  const { path, seq, updatedAt, keyId, env } = loaded

  // Non-blocking capture log for interceptor panel
  void logCapture(path, seq, env.iv, env.ciphertext.slice(0, 64))

  return c.body(env.ciphertext, 200, {
    'Content-Type': 'text/plain',
    'Cache-Control': 'no-cache',
    [PROOF_HEADER]: env.proof,
    'X-Nodex-Cache-Scope': 'public',
    'X-Nodex-Seq': String(seq),
    'X-Nodex-Iv': env.iv,
    'X-Nodex-Key-Id': keyId,
    'X-Nodex-Updated-At': String(updatedAt),
    'X-Nodex-Validated-At': String(env.validatedAt),
  })
})

const handler = handle(app)
export const GET = handler
export const OPTIONS = handler
