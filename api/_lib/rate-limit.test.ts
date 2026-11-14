import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createLimiter, rateLimited } from './rate-limit.js'

describe('rate limiter', () => {
  it('allows up to the limit, then blocks until the window resets', () => {
    const check = createLimiter(2, 1000)
    expect(check('k', 0).allowed).toBe(true)
    expect(check('k', 10).allowed).toBe(true)
    const blocked = check('k', 20)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSec).toBe(1)
    expect(check('k', 1000).allowed).toBe(true)
  })

  it('keeps keys independent and bounds memory', () => {
    const check = createLimiter(1, 60_000)
    expect(check('a', 0).allowed).toBe(true)
    expect(check('b', 0).allowed).toBe(true)
    for (let i = 0; i < 10_050; i++) check(`flood-${i}`, 1)
    expect(check('fresh', 2).allowed).toBe(true)
  })

  it('returns 429 with Retry-After per credential and never limits preflight', async () => {
    const app = new Hono()
    app.use('*', rateLimited(2))
    app.all('/x', c => c.text('ok'))
    const call = (auth: string, method = 'GET') => app.request('/x', { method, headers: { Authorization: auth } })
    expect((await call('Bearer a')).status).toBe(200)
    expect((await call('Bearer a')).status).toBe(200)
    const limited = await call('Bearer a')
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect((await call('Bearer b')).status).toBe(200)
    expect((await call('Bearer a', 'OPTIONS')).status).toBe(200)
  })
})
