import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import { validateBetaToken } from '../lib/auth.js'
import { getSequenceAuthority } from '../../src/server/sequence-authority-provider.js'
import { SequenceAuthorityInputError } from '../../src/server/sequence-authority.js'

export const config = { runtime: 'nodejs' }
export const app = new Hono()
app.use('*', cors({ origin: '*', allowHeaders: ['Authorization','Idempotency-Key','Content-Type'] }))
app.use('*', bodyLimit({ maxSize: 1024 }))
app.onError(() => new Response(JSON.stringify({ error: 'sequence authority unavailable' }), {
  status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '1' },
}))
app.post('/api/invalidate/*', async c => {
  if (!await validateBetaToken(c.req.raw, 'admin')) return c.json({ error: 'unauthorized' }, 401)
  const suffix = c.req.path.slice('/api/invalidate'.length)
  const key = suffix.startsWith('/api/') ? suffix : '/api' + suffix
  if (!/^\/api\/products\/[a-zA-Z0-9_-]{1,240}$/.test(key)) return c.json({ error: 'invalid resource' }, 400)
  try {
    const result = await getSequenceAuthority().bump(key, c.req.header('Idempotency-Key') ?? '')
    c.header('Cache-Control', 'no-store')
    return c.json({ path: key, ...result, invalidated: true, invalidation: 'queued' })
  } catch (error) {
    if (error instanceof SequenceAuthorityInputError) return c.json({ error: 'invalid invalidation command' }, 400)
    throw error
  }
})
const handler = handle(app)
export const POST = handler
export const OPTIONS = handler
