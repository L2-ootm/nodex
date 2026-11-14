import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { bodyLimit } from 'hono/body-limit'
import { validateBetaToken } from '../_lib/auth.js'
import { getSequenceAuthority } from '../../src/server/sequence-authority-provider.js'
import { cloneSnapshot, SequenceAuthorityInputError } from '../../src/server/sequence-authority.js'

export const config = { runtime: 'nodejs' }
export const app = new Hono()
app.use('*', bodyLimit({ maxSize: 70_000 }))
app.onError(() => new Response(JSON.stringify({ error: 'snapshot authority unavailable' }), {
  status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '1' },
}))
app.post('/api/write/*', async c => {
  if (!await validateBetaToken(c.req.raw, 'admin')) return c.json({ error: 'unauthorized' }, 401)
  const key = c.req.path.slice('/api/write'.length)
  if (!/^\/api\/products\/[a-zA-Z0-9_-]+$/.test(key) || key.length > 256) return c.json({ error: 'invalid resource' }, 400)
  const input: unknown = await c.req.json().catch(() => null)
  if (!input || typeof input !== 'object' || Array.isArray(input)) return c.json({ error: 'invalid snapshot command' }, 400)
  const body = input as Record<string, unknown>
  const baseVersion = body['baseVersion']
  if (!Number.isSafeInteger(baseVersion) || Number(baseVersion) < 0) return c.json({ error: 'invalid baseVersion' }, 400)
  try {
    const result = await getSequenceAuthority().write(key, c.req.header('Idempotency-Key') ?? '',
      Number(baseVersion), cloneSnapshot(body['data']))
    c.header('Cache-Control', 'no-store')
    if ('conflict' in result) return c.json({ error: 'conflict', currentVersion: result.currentVersion }, 409)
    return c.json({ path: key, version: result.seq, eventId: result.eventId,
      duplicate: result.duplicate, invalidation: 'queued' })
  } catch (error) {
    if (error instanceof SequenceAuthorityInputError) return c.json({ error: 'invalid snapshot or retry identity' }, 400)
    throw error
  }
})
const handler = handle(app)
export const POST = handler
