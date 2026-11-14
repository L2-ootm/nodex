import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { cors } from 'hono/cors'
import { validateBetaToken, unauthorizedResponse } from './_lib/auth.js'
import { rateLimited } from './_lib/rate-limit.js'
import type { IceServerConfig } from '../src/shared/config.js'
import { createHash, createHmac } from 'node:crypto'

export const config = { runtime: 'nodejs' }

const TURN_TTL_MS = 60 * 60 * 1000  // 1 hour

function getTurnServers(token: string): { servers: IceServerConfig[]; expiresAt: number | null; mode: string } {
  const urlsRaw = process.env['NODEX_TURN_URLS'] ?? ''
  const username = process.env['NODEX_TURN_USERNAME'] ?? ''
  const credential = process.env['NODEX_TURN_CREDENTIAL'] ?? ''

  const urls = urlsRaw.split(',').map((u) => u.trim()).filter(Boolean)
  if (urls.length === 0) return { servers: [], expiresAt: null, mode: 'none' }
  if (urls.some(url => !/^turns?:[^\s]+$/.test(url))) throw new Error('Invalid TURN URL')
  const secret = process.env['NODEX_TURN_SHARED_SECRET']
  if (secret) {
    if (secret.length < 32) throw new Error('TURN secret must have at least 32 characters')
    const expiresAt = Math.floor((Date.now() + TURN_TTL_MS) / 1000) * 1000
    const user = `${expiresAt / 1000}:${createHash('sha256').update(token).digest('hex').slice(0, 24)}`
    const password = createHmac('sha1', secret).update(user).digest('base64')
    return { servers: urls.map(url => ({ urls: url, username: user, credential: password })), expiresAt, mode: 'coturn-rest' }
  }
  if (!username || !credential || (process.env['NODE_ENV'] === 'production' && process.env['NODEX_ALLOW_STATIC_TURN'] !== 'true')) {
    throw new Error('Timed TURN credentials unavailable')
  }
  return { servers: urls.map(url => ({ urls: url, username, credential })), expiresAt: null, mode: 'static' }
}

export const app = new Hono()
app.use('*', cors({ origin: '*' }))
app.onError(() => new Response(JSON.stringify({ error: 'TURN configuration unavailable' }), {
  status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
}))

app.use('/api/turn-credentials', rateLimited(20))
app.get('/api/turn-credentials', async (c) => {
  if (!await validateBetaToken(c.req.raw, 'tester')) {
    return c.newResponse(unauthorizedResponse().body, 401, {
      'Content-Type': 'application/json',
    })
  }

  const token = c.req.header('Authorization')!.slice(7).trim()
  const turn = getTurnServers(token)
  const iceServers: IceServerConfig[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    ...turn.servers,
  ]

  c.header('Cache-Control', 'no-store')
  return c.json({
    iceServers,
    expiresAt: turn.expiresAt,
    credentialMode: turn.mode,
  })
})

const handler = handle(app)
export const GET = handler
export const OPTIONS = handler
