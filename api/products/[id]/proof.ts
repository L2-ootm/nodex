import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { cors } from 'hono/cors'
import { loadProductEnvelope } from '../../_lib/product-envelope.js'
import { renewalHeaders } from '../../../src/server/snapshot-envelope.js'
import { PROOF_HEADER } from '../../../src/crypto/publisher-proof.js'
import { rateLimited } from '../../_lib/rate-limit.js'

export const config = { runtime: 'nodejs' }

// Small signed renewal for a version whose ciphertext a peer or cache already holds. It signs the
// digest of the current version's canonical ciphertext; a reader accepts it only if version, IV and
// digest match the bytes it holds.
export const app = new Hono()
app.onError(() => new Response('Publisher unavailable', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' } }))
app.use('*', cors({ origin: '*',
  exposeHeaders: [PROOF_HEADER, 'X-Nodex-Seq', 'X-Nodex-Iv', 'X-Nodex-Key-Id', 'X-Nodex-Validated-At'] }))
app.use('/api/products/:id/proof', rateLimited(600))
app.get('/api/products/:id/proof', async (c) => {
  const loaded = await loadProductEnvelope(c.req.param('id'))
  if (!loaded.ok) return c.body(loaded.body, loaded.status, { 'Cache-Control': 'no-store', 'Retry-After': '1' })
  return c.body(null, 204, renewalHeaders(loaded.env, loaded.seq, loaded.keyId))
})
const handler = handle(app)
export const GET = handler
export const OPTIONS = handler
