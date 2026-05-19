// src/server/mock-api.ts
// Hono mock API server for Phase 1
// Routes: GET /api/products/:id (X-Nodex-Seq header), POST /api/invalidate/:path, GET /api/__test__/seq/:path
// CORS: allows http://localhost:3000 so SW fetch() gets readable responses (not opaque)

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'

const app = new Hono()

// CORS must be applied BEFORE route handlers (Pitfall 7 — critical blocker if missed)
// Opaque responses make response.headers.get('X-Nodex-Seq') return null, breaking the
// entire freshness system.
app.use('*', cors({ origin: 'http://localhost:3000' }))

// In-memory sequence counter — exported for test access (per D-10 and CONTEXT.md specifics)
// Unit tests import this Map directly; Playwright integration tests use the HTTP endpoint.
export const seqCounters = new Map<string, number>()

// GET /api/products/:id — returns product JSON with X-Nodex-Seq header
// Initial seq for any path is 1 (first GET returns seq 1, not 0)
app.get('/api/products/:id', (c) => {
  const id = c.req.param('id')
  const path = `/api/products/${id}`
  if (!seqCounters.has(path)) {
    seqCounters.set(path, 1)
  }
  const seq = seqCounters.get(path)!
  return c.json(
    { id, name: `Product ${id}`, price: 9.99 },
    200,
    { 'X-Nodex-Seq': String(seq) }
  )
})

// POST /api/invalidate/:path{.+$} — bumps sequence counter for the given path
// Reconstructs path as '/' + param to normalize to '/api/products/1' form
app.post('/api/invalidate/:path{.+$}', (c) => {
  const path = '/' + c.req.param('path')
  const current = seqCounters.get(path) ?? 1
  const newSeq = current + 1
  seqCounters.set(path, newSeq)
  return c.json({ path, newSeq })
})

// GET /api/__test__/seq/:path{.+$} — test introspection endpoint
// Returns current sequence number for a path — used by Playwright integration tests
// and Phase 5 test harness for controlled sequence injection
app.get('/api/__test__/seq/:path{.+$}', (c) => {
  const path = '/' + c.req.param('path')
  const seq = seqCounters.get(path) ?? 1
  return c.json({ path, seq })
})

// Only start the HTTP server when not running under vitest/test environment
// This prevents port binding during unit tests which import app directly
if (process.env['NODE_ENV'] !== 'test') {
  serve({ fetch: app.fetch, port: 3001 }, (info) => {
    console.log(`[Nodex Mock API] Listening on http://localhost:${info.port}`)
  })
}

export { app }
