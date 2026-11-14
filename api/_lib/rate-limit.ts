import { createHash } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

// shortcut: per-instance memory. Serverless instances do not share counters, so the effective
// ceiling is limit x instances. Move to a shared store (Redis/Upstash/Postgres) before a pilot
// that must enforce a hard global ceiling.
const MAX_TRACKED_KEYS = 10_000

export function createLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>()
  return function check(key: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    if (hits.size >= MAX_TRACKED_KEYS) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k)
      if (hits.size >= MAX_TRACKED_KEYS) hits.clear() // fail open to bounded memory, never to a crash
    }
    const entry = hits.get(key)
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs })
      return { allowed: true, retryAfterSec: 0 }
    }
    entry.count++
    return { allowed: entry.count <= limit, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) }
  }
}

/** Limits per credential (hash of the Authorization header), before authentication, so guessing is throttled too. */
export function rateLimited(limit: number, windowMs = 60_000): MiddlewareHandler {
  const check = createLimiter(limit, windowMs)
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next()
    const key = createHash('sha256').update(c.req.header('Authorization') ?? 'anonymous').digest('hex')
    const result = check(key)
    if (!result.allowed) {
      return c.json({ error: 'rate limited' }, 429, { 'Retry-After': String(result.retryAfterSec), 'Cache-Control': 'no-store' })
    }
    return next()
  }
}
