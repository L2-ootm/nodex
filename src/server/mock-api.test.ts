// src/server/mock-api.test.ts
// Unit tests for the Hono mock API server
// Uses Hono's testClient for in-process testing (no real HTTP server)

import { describe, it, expect, beforeEach } from 'vitest'
import { app, seqCounters, sessionKeyBytes } from './mock-api.js'

describe('mock-api', () => {
  beforeEach(() => {
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
    await app.request('/api/products/1')
    const invalidateRes = await app.request('/api/invalidate/api/products/1', {
      method: 'POST',
    })
    const body = await invalidateRes.json() as { path: string; newSeq: number }
    expect(body.path).toBe('/api/products/1')
    expect(body.newSeq).toBe(2)
  })

  it('Test 4: GET /api/__test__/seq/api/products/1 returns { path: "/api/products/1", seq: 2 } after invalidate', async () => {
    await app.request('/api/products/1')
    await app.request('/api/invalidate/api/products/1', { method: 'POST' })
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

  it('Test 7: GET /api/products/1 body is a non-empty base64 string (not plaintext JSON)', async () => {
    const res = await app.request('/api/products/1')
    const body = await res.text()
    // Base64 characters only — no JSON braces
    expect(body).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(body).not.toContain('{')
  })

  it('Test 8: GET /api/products/1 includes X-Nodex-Iv and X-Nodex-Key-Id headers', async () => {
    const res = await app.request('/api/products/1')
    const iv = res.headers.get('X-Nodex-Iv')
    const keyId = res.headers.get('X-Nodex-Key-Id')
    expect(iv).not.toBeNull()
    expect(iv!.length).toBeGreaterThan(0)
    expect(keyId).toBe('default')
  })

  it('Test 9: GET /api/products/1 X-Nodex-Iv decodes to 12 bytes (96-bit AES-GCM IV)', async () => {
    const res = await app.request('/api/products/1')
    const iv = res.headers.get('X-Nodex-Iv')!
    const ivBytes = Buffer.from(iv, 'base64')
    expect(ivBytes.length).toBe(12)
  })

  it('Test 10: GET /api/session-key returns { keyId: "default", keyBytes } with 44-char base64', async () => {
    const res = await app.request('/api/session-key')
    expect(res.status).toBe(200)
    const body = await res.json() as { keyId: string; keyBytes: string }
    expect(body.keyId).toBe('default')
    expect(body.keyBytes).toMatch(/^[A-Za-z0-9+/]+=*$/)
    // 32 bytes = 44 base64 chars (with padding)
    expect(body.keyBytes.length).toBe(44)
  })

  it('Test 11: GET /api/session-key keyBytes decodes to 32 bytes (AES-256)', async () => {
    const res = await app.request('/api/session-key')
    const body = await res.json() as { keyId: string; keyBytes: string }
    const keyBuf = Buffer.from(body.keyBytes, 'base64')
    expect(keyBuf.length).toBe(32)
  })

  it('Test 12: sessionKeyBytes export matches /api/session-key keyBytes', async () => {
    const res = await app.request('/api/session-key')
    const body = await res.json() as { keyId: string; keyBytes: string }
    const fromExport = Buffer.from(sessionKeyBytes).toString('base64')
    expect(fromExport).toBe(body.keyBytes)
  })

  it('Test 13: POST /api/gossip-seed returns { seededNodeIds: [] } when no peers connected', async () => {
    const res = await app.request('/api/gossip-seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/api/products/1', seq: 2 }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { seededNodeIds: string[] }
    expect(Array.isArray(body.seededNodeIds)).toBe(true)
    expect(body.seededNodeIds.length).toBe(0)
  })

  it('Test 14: two consecutive GET /api/products/1 calls produce different X-Nodex-Iv values (fresh IV per request)', async () => {
    const res1 = await app.request('/api/products/1')
    const res2 = await app.request('/api/products/1')
    const iv1 = res1.headers.get('X-Nodex-Iv')
    const iv2 = res2.headers.get('X-Nodex-Iv')
    expect(iv1).not.toBeNull()
    expect(iv2).not.toBeNull()
    expect(iv1).not.toBe(iv2)
  })

  it('Test 15: ciphertext from /api/products/1 decrypts to valid product JSON using session key', async () => {
    const keyRes = await app.request('/api/session-key')
    const { keyBytes } = await keyRes.json() as { keyId: string; keyBytes: string }
    const keyBuf = Buffer.from(keyBytes, 'base64')
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'raw',
      keyBuf,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    )

    const prodRes = await app.request('/api/products/42')
    const ct = await prodRes.text()
    const iv = Buffer.from(prodRes.headers.get('X-Nodex-Iv')!, 'base64')

    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      Buffer.from(ct, 'base64')
    )
    const json = JSON.parse(new TextDecoder().decode(plaintext)) as { id: string; name: string; price: number }
    expect(json.id).toBe('42')
    expect(json.name).toBe('Product 42')
    expect(json.price).toBe(9.99)
  })
})
