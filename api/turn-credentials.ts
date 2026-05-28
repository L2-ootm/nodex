import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { cors } from 'hono/cors'
import { validateBetaToken, unauthorizedResponse } from './lib/auth.js'
import type { IceServerConfig } from '../src/shared/config.js'

export const config = { runtime: 'nodejs' }

const TURN_TTL_MS = 60 * 60 * 1000  // 1 hour

function getTurnServers(): IceServerConfig[] {
  const urlsRaw = process.env['NODEX_TURN_URLS'] ?? ''
  const username = process.env['NODEX_TURN_USERNAME'] ?? ''
  const credential = process.env['NODEX_TURN_CREDENTIAL'] ?? ''

  const urls = urlsRaw.split(',').map((u) => u.trim()).filter(Boolean)
  if (urls.length === 0 || !username || !credential) return []

  return urls.map((url) => ({ urls: url, username, credential }))
}

const app = new Hono()
app.use('*', cors({ origin: '*' }))

app.get('/api/turn-credentials', (c) => {
  if (!validateBetaToken(c.req.raw, 'tester')) {
    return c.newResponse(unauthorizedResponse().body, 401, {
      'Content-Type': 'application/json',
    })
  }

  const turnServers = getTurnServers()
  const iceServers: IceServerConfig[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    ...turnServers,
  ]

  return c.json({
    iceServers,
    expiresAt: Date.now() + TURN_TTL_MS,
  })
})

const handler = handle(app)
export const GET = handler
export const OPTIONS = handler
