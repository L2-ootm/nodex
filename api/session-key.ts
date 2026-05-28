import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { cors } from 'hono/cors'
import { ENCRYPTION_KEY_ID } from '../src/shared/config.js'
import { validateBetaToken, unauthorizedResponse } from './lib/auth.js'

export const config = { runtime: 'nodejs' }

function getSessionKeyBytes(): Uint8Array {
  const hex = process.env['NODEX_SESSION_KEY_HEX'] ?? ''
  if (/^[0-9a-f]{64}$/i.test(hex)) {
    return new Uint8Array(Buffer.from(hex, 'hex'))
  }
  const seed = 'nodex-dev-key-32bytes-padding!!!'
  return new TextEncoder().encode(seed.slice(0, 32))
}

const app = new Hono()
app.use('*', cors({ origin: '*' }))

app.get('/api/session-key', (c) => {
  if (!validateBetaToken(c.req.raw, 'tester')) {
    return c.newResponse(unauthorizedResponse().body, 401, {
      'Content-Type': 'application/json',
    })
  }
  const keyBytes = getSessionKeyBytes()
  const keyB64 = Buffer.from(keyBytes).toString('base64')
  return c.json({ keyId: ENCRYPTION_KEY_ID, keyBytes: keyB64 })
})

const handler = handle(app)
export const GET = handler
export const OPTIONS = handler
