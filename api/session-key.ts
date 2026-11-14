import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { cors } from 'hono/cors'
import { configuredSessionKey } from '../src/server/session-key.js'
import { validateBetaToken, unauthorizedResponse } from './_lib/auth.js'
import { rateLimited } from './_lib/rate-limit.js'

export const config = { runtime: 'nodejs' }

const app = new Hono()
app.onError(() => new Response(JSON.stringify({ error: 'session key unavailable' }), {
  status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
}))
app.use('*', cors({ origin: '*', exposeHeaders: ['X-Nodex-Commit'] }))

app.use('/api/session-key', rateLimited(30))
app.get('/api/session-key', async (c) => {
  if (!await validateBetaToken(c.req.raw, 'tester')) {
    return c.newResponse(unauthorizedResponse().body, 401, {
      'Content-Type': 'application/json',
    })
  }
  const { bytes: keyBytes, keyId } = configuredSessionKey()
  c.header('Cache-Control', 'no-store')
  const keyB64 = Buffer.from(keyBytes).toString('base64')
  c.header('X-Nodex-Commit', process.env['VERCEL_GIT_COMMIT_SHA']?.trim() || 'unknown')
  return c.json({ keyId, keyBytes: keyB64 })
})

const handler = handle(app)
export const GET = handler
export const OPTIONS = handler
