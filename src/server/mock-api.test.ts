// src/server/mock-api.test.ts
// Unit tests for the Hono mock API server
// Uses Hono's testClient for in-process testing (no real HTTP server)

import { describe, it, expect, beforeEach } from 'vitest'
import { app, seqCounters } from './mock-api.js'

describe('mock-api', () => {
  beforeEach(() => {
    // Reset seq counters between tests
    seqCounters.clear()
  })

  it('Test 1: GET /api/products/1 returns status 200', async () => {
    const res = await app.request('/api/products/1')
    expect(res.status).toBe(200)
  })

  it('Test 2: GET /api/products/1 response includes X-Nodex-Seq header with a numeric string value', async () => {
    const res = await app.request('/api/products/1')
    const seq = res.headers.get('X-Nodex-Seq')
    expect(seq).not.toBeNull()
    expect(Number.isNaN(Number(seq))).toBe(false)
    expect(Number(seq)).toBeGreaterThan(0)
  })

  it('Test 3: POST /api/invalidate/api/products/1 returns { path: "/api/products/1", newSeq: 2 } when seq was 1', async () => {
    // First GET to initialize seq to 1
    await app.request('/api/products/1')

    // POST to invalidate — should bump from 1 to 2
    const invalidateRes = await app.request('/api/invalidate/api/products/1', {
      method: 'POST',
    })
    const body = await invalidateRes.json() as { path: string; newSeq: number }
    expect(body.path).toBe('/api/products/1')
    expect(body.newSeq).toBe(2)
  })

  it('Test 4: GET /api/__test__/seq/api/products/1 returns { path: "/api/products/1", seq: 2 } after the invalidate above', async () => {
    // Initialize seq to 1 via GET
    await app.request('/api/products/1')
    // Invalidate to bump seq to 2
    await app.request('/api/invalidate/api/products/1', { method: 'POST' })

    // Introspect via test endpoint
    const res = await app.request('/api/__test__/seq/api/products/1')
    const body = await res.json() as { path: string; seq: number }
    expect(body.path).toBe('/api/products/1')
    expect(body.seq).toBe(2)
  })

  it('Test 5: exported seqCounters Map contains "/api/products/1" with value 2 after full sequence', async () => {
    await app.request('/api/products/1')
    await app.request('/api/invalidate/api/products/1', { method: 'POST' })
    expect(seqCounters.get('/api/products/1')).toBe(2)
  })

  it('Test 6: GET /api/products/1 returns Access-Control-Allow-Origin header (CORS)', async () => {
    const res = await app.request('/api/products/1', {
      headers: { Origin: 'http://localhost:3000' },
    })
    const corsHeader = res.headers.get('Access-Control-Allow-Origin')
    expect(corsHeader).not.toBeNull()
  })
})
