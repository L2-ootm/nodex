import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { cors } from 'hono/cors'
import { TIME_NONCE_PATTERN } from '../src/crypto/publisher-proof.js'
import { publishTime } from '../src/server/publisher.js'
import { rateLimited } from './lib/rate-limit.js'

export const config = { runtime: 'nodejs' }

// Signed server time for a client-chosen nonce. It lets a reader anchor its freshness clock to
// the publisher without trusting its own wall clock or any cacheable response.
export const app = new Hono()
app.onError(() => new Response('Publisher unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } }))
app.use('*', cors({ origin: '*' }))
app.use('/api/time', rateLimited(60))
app.get('/api/time', async (c) => {
  const nonce = c.req.query('nonce') ?? ''
  if (!TIME_NONCE_PATTERN.test(nonce)) return c.json({ error: 'invalid nonce' }, 400, { 'Cache-Control': 'no-store' })
  return c.json(await publishTime(nonce), 200, { 'Cache-Control': 'no-store' })
})
const handler = handle(app)
export const GET = handler
export const OPTIONS = handler
