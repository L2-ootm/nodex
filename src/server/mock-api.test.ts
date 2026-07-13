// src/server/mock-api.test.ts
// Unit tests for the Hono mock API server
// Uses Hono's testClient for in-process testing (no real HTTP server)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { app, seqCounters, sessionKeyBytes } from './mock-api.js'
import { buildPayloadAad } from '../crypto/crypto.js'

describe('mock-api', () => {
  beforeEach(() => {
    seqCounters.clear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
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
    vi.stubEnv('NODEX_ENABLE_TEST_FAULTS', 'true')
    await app.request('/api/products/1')
    await app.request('/api/invalidate/api/products/1', { method: 'POST' })
    const res = await app.request('/api/__test__/seq/api/products/1')
    const body = await res.json() as { path: string; seq: number }
    expect(body.path).toBe('/api/products/1')
    expect(body.seq).toBe(2)
  })

  it('ignores sequence fault injection unless explicitly enabled', async () => {
    const res = await app.request('/api/products/1?__nodex_test_seq=99')
    expect(res.headers.get('X-Nodex-Seq')).toBe('1')
    expect((await app.request('/api/__test__/seq/api/products/1')).status).toBe(404)
  })

  it('keeps test faults disabled in production even if the flag is set', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NODEX_ENABLE_TEST_FAULTS', 'true')
    const res = await app.request('/api/products/1?__nodex_test_seq=99')
    expect(res.headers.get('X-Nodex-Seq')).toBe('1')
    expect((await app.request('/api/__test__/seq/api/products/1')).status).toBe(404)
  })

  it('allows sequence fault injection only with the explicit test flag', async () => {
    vi.stubEnv('NODEX_ENABLE_TEST_FAULTS', 'true')
    const res = await app.request('/api/products/1?__nodex_test_seq=99')
    expect(res.headers.get('X-Nodex-Seq')).toBe('99')
    expect((await app.request('/api/__test__/seq/api/products/1')).status).toBe(200)
  })

  it('Test 5: exported seqCounters Map contains "/api/products/1" with value 2 after full sequence', async () => {
    await app.request('/api/products/1')
    await app.request('/api/invalidate/api/products/1', { method: 'POST' })
    expect(seqCounters.get('/api/products/1')).toBe(2)
  })

  it('Test 6: GET /api/products/1 returns Access-Control-Allow-Origin header (CORS)', async () => {
    const res = await app.request('/api/products/1', {
      headers: { Origin: 'http://localhost:4173' },
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
    const validatedAt = Number(prodRes.headers.get('X-Nodex-Validated-At'))

    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: buildPayloadAad('/api/products/42', 1, 'default', validatedAt) },
      cryptoKey,
      Buffer.from(ct, 'base64')
    )
    const json = JSON.parse(new TextDecoder().decode(plaintext)) as { id: string; name: string; price: number }
    expect(json.id).toBe('42')
    expect(json.name).toBe('Product 42')
    expect(json.price).toBe(9.99)
  })

  it('Test 16: ciphertext rejects forged seq metadata through AES-GCM AAD', async () => {
    const keyRes = await app.request('/api/session-key')
    const { keyBytes } = await keyRes.json() as { keyId: string; keyBytes: string }
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'raw',
      Buffer.from(keyBytes, 'base64'),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    )

    const prodRes = await app.request('/api/products/42')
    const ct = await prodRes.text()
    const iv = Buffer.from(prodRes.headers.get('X-Nodex-Iv')!, 'base64')
    const validatedAt = Number(prodRes.headers.get('X-Nodex-Validated-At'))

    await expect(
      globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: buildPayloadAad('/api/products/42', 999, 'default', validatedAt) },
        cryptoKey,
        Buffer.from(ct, 'base64')
      )
    ).rejects.toBeInstanceOf(DOMException)
  })

  it('ciphertext rejects a forged X-Nodex-Validated-At value', async () => {
    const keyRes = await app.request('/api/session-key')
    const { keyBytes } = await keyRes.json() as { keyBytes: string }
    const cryptoKey = await globalThis.crypto.subtle.importKey('raw', Buffer.from(keyBytes, 'base64'), { name: 'AES-GCM' }, false, ['decrypt'])
    const prodRes = await app.request('/api/products/42')
    const ct = await prodRes.text()
    const iv = Buffer.from(prodRes.headers.get('X-Nodex-Iv')!, 'base64')
    const validatedAt = Number(prodRes.headers.get('X-Nodex-Validated-At'))
    await expect(globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: buildPayloadAad('/api/products/42', 1, 'default', validatedAt + 1) },
      cryptoKey,
      Buffer.from(ct, 'base64')
    )).rejects.toBeInstanceOf(DOMException)
  })
})

describe('mock-api — version metadata headers (IMPL-01)', () => {
  beforeEach(() => {
    seqCounters.clear()
  })

  it('X-Nodex-Version equals X-Nodex-Seq', async () => {
    const res = await app.request('/api/products/1')
    expect(res.headers.get('X-Nodex-Version')).toBe(res.headers.get('X-Nodex-Seq'))
  })

  it('X-Nodex-Version is a numeric string greater than 0', async () => {
    const res = await app.request('/api/products/1')
    const version = res.headers.get('X-Nodex-Version')
    expect(version).not.toBeNull()
    expect(Number.isNaN(Number(version))).toBe(false)
    expect(Number(version)).toBeGreaterThan(0)
  })

  it('X-Nodex-Updated-At is epoch ms', async () => {
    const res = await app.request('/api/products/1')
    const updatedAt = res.headers.get('X-Nodex-Updated-At')
    expect(updatedAt).not.toBeNull()
    expect(Number.isInteger(Number(updatedAt!))).toBe(true)
    expect(Number(updatedAt!)).toBeGreaterThan(0)
  })

  it('X-Nodex-Validated-At is a fresh epoch timestamp', async () => {
    const before = Date.now()
    const res = await app.request('/api/products/1')
    const validatedAt = Number(res.headers.get('X-Nodex-Validated-At'))
    expect(Number.isSafeInteger(validatedAt)).toBe(true)
    expect(validatedAt).toBeGreaterThanOrEqual(before)
    expect(validatedAt).toBeLessThanOrEqual(Date.now())
  })

  it('X-Nodex-Policy equals bounded-staleness', async () => {
    const res = await app.request('/api/products/1')
    expect(res.headers.get('X-Nodex-Policy')).toBe('bounded-staleness')
  })

  it('X-Nodex-Max-Stale-Versions equals 2', async () => {
    const res = await app.request('/api/products/1')
    expect(res.headers.get('X-Nodex-Max-Stale-Versions')).toBe('2')
  })

  it('X-Nodex-Max-Stale-Ms equals 5000', async () => {
    const res = await app.request('/api/products/1')
    expect(res.headers.get('X-Nodex-Max-Stale-Ms')).toBe('5000')
  })

  it('X-Nodex-Content-Hash starts with sha256: and hex part is 64 chars', async () => {
    const res = await app.request('/api/products/1')
    const hash = res.headers.get('X-Nodex-Content-Hash')
    expect(hash).not.toBeNull()
    expect(hash!.startsWith('sha256:')).toBe(true)
    const hexPart = hash!.slice('sha256:'.length)
    expect(hexPart).toHaveLength(64)
    expect(hexPart).toMatch(/^[0-9a-f]{64}$/)
  })

  it('X-Nodex-Etag matches "v{N}" pattern', async () => {
    const res = await app.request('/api/products/1')
    const etag = res.headers.get('X-Nodex-Etag')
    expect(etag).not.toBeNull()
    expect(etag).toMatch(/^"v[0-9]+"$/)
  })

  it('existing X-Nodex-Seq header is still present (backward compat)', async () => {
    const res = await app.request('/api/products/1')
    const seq = res.headers.get('X-Nodex-Seq')
    expect(seq).not.toBeNull()
    expect(Number(seq)).toBeGreaterThan(0)
  })
})

describe('mock-api — OCC write endpoint (IMPL-03)', () => {
  beforeEach(() => {
    seqCounters.clear()
  })

  it('write accepted (200) when baseVersion matches initial seq', async () => {
    await app.request('/api/products/1')
    const res = await app.request('/api/write/api/products/1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion: 1, data: {} }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { version: number; path: string }
    expect(body.version).toBe(2)
    expect(body.path).toBe('/api/products/1')
  })

  it('write rejected (409) when baseVersion is stale', async () => {
    await app.request('/api/products/1')
    await app.request('/api/invalidate/api/products/1', { method: 'POST' })
    const res = await app.request('/api/write/api/products/1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion: 1, data: {} }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string; currentVersion: number; baseVersion: number }
    expect(body.error).toBe('conflict')
    expect(body.currentVersion).toBe(2)
    expect(body.baseVersion).toBe(1)
  })

  it('409 response body contains currentVersion and baseVersion as numbers', async () => {
    await app.request('/api/products/1')
    await app.request('/api/invalidate/api/products/1', { method: 'POST' })
    const res = await app.request('/api/write/api/products/1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion: 1, data: {} }),
    })
    const body = await res.json() as { error: string; currentVersion: number; baseVersion: number }
    expect(typeof body.currentVersion).toBe('number')
    expect(typeof body.baseVersion).toBe('number')
  })

  it('400 on missing baseVersion', async () => {
    const res = await app.request('/api/write/api/products/1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('baseVersion required')
  })

  it('400 on invalid JSON body', async () => {
    const res = await app.request('/api/write/api/products/1', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('invalid json')
  })

  it('successful write advances seqCounters to 2', async () => {
    await app.request('/api/products/1')
    await app.request('/api/write/api/products/1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion: 1, data: {} }),
    })
    expect(seqCounters.get('/api/products/1')).toBe(2)
  })
})

// NX-07: Beta auth gate tests
describe('mock-api — NX-07 auth gate', () => {
  beforeEach(() => {
    seqCounters.clear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns 200 without auth when enforcement is off (default dev behavior)', async () => {
    vi.stubEnv('NODEX_BETA_ENFORCE_AUTH', 'false')
    const res = await app.request('/api/products/1')
    expect(res.status).toBe(200)
  })

  it('returns 401 when enforcement is on and no Authorization header is provided', async () => {
    vi.stubEnv('NODEX_BETA_ENFORCE_AUTH', 'true')
    vi.stubEnv('NODEX_BETA_TOKENS', 'valid-token-abc')
    const res = await app.request('/api/products/1')
    expect(res.status).toBe(401)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 401 when enforcement is on and token does not match', async () => {
    vi.stubEnv('NODEX_BETA_ENFORCE_AUTH', 'true')
    vi.stubEnv('NODEX_BETA_TOKENS', 'valid-token-abc')
    const res = await app.request('/api/products/1', {
      headers: { Authorization: 'Bearer wrong-token' },
    })
    expect(res.status).toBe(401)
  })

  it('returns 200 when enforcement is on and valid token is provided', async () => {
    vi.stubEnv('NODEX_BETA_ENFORCE_AUTH', 'true')
    vi.stubEnv('NODEX_BETA_TOKENS', 'valid-token-abc,another-token')
    const res = await app.request('/api/products/1', {
      headers: { Authorization: 'Bearer valid-token-abc' },
    })
    expect(res.status).toBe(200)
  })

  it('accepts any token from comma-separated NODEX_BETA_TOKENS list', async () => {
    vi.stubEnv('NODEX_BETA_ENFORCE_AUTH', 'true')
    vi.stubEnv('NODEX_BETA_TOKENS', 'token-a,token-b,token-c')
    const res = await app.request('/api/products/99', {
      headers: { Authorization: 'Bearer token-c' },
    })
    expect(res.status).toBe(200)
  })

  it('auth gate only applies to /api/products/:id — session-key still unauthenticated', async () => {
    vi.stubEnv('NODEX_BETA_ENFORCE_AUTH', 'true')
    vi.stubEnv('NODEX_BETA_TOKENS', 'valid-token-abc')
    const res = await app.request('/api/session-key')
    expect(res.status).toBe(200)
  })
})
