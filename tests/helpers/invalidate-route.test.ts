import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '../../apps/beta-suite/app/api/invalidate/[...path]/route.js'

const authorityBump = vi.hoisted(() => vi.fn())
const InputError = vi.hoisted(() => class SequenceAuthorityInputError extends Error {})

vi.mock('../../src/server/sequence-authority-provider', () => ({
  getSequenceAuthority: () => ({ bump: authorityBump }),
}))

vi.mock('../../src/server/sequence-authority', () => ({
  SequenceAuthorityInputError: InputError,
}))

const eventId = '018f5b79-24c1-7a63-abfd-46a8c5ae23e7'

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/invalidate/products/1', {
    method: 'POST',
    headers,
  })
}

function invoke(req: NextRequest) {
  return POST(req, { params: Promise.resolve({ path: ['products', '1'] }) })
}

describe('atomic invalidation route', () => {
  beforeEach(() => {
    vi.stubEnv('NODEX_BETA_ADMIN_TOKENS', 'admin-token')
    authorityBump.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('rejects unauthorized requests before touching sequence state', async () => {
    expect((await invoke(request())).status).toBe(401)
    expect(authorityBump).not.toHaveBeenCalled()
  })

  it('requires a valid idempotency key', async () => {
    authorityBump.mockRejectedValueOnce(new InputError())
    const response = await invoke(request({ Authorization: 'Bearer admin-token' }))
    expect(response.status).toBe(400)
  })

  it('fails closed and does not notify when the authority is unavailable', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubEnv('NODEX_BETA_SIGNALING_HTTP_URL', 'https://signal.example')
    authorityBump.mockRejectedValueOnce(new Error('database unavailable'))

    const response = await invoke(request({
      Authorization: 'Bearer admin-token',
      'Idempotency-Key': eventId,
    }))

    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Retry-After')).toBe('1')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns and propagates the committed sequence and event identity', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubEnv('NODEX_BETA_SIGNALING_HTTP_URL', 'https://signal.example')
    authorityBump.mockResolvedValue({ seq: 9, updatedAt: 1_000_000, eventId, duplicate: false })

    const response = await invoke(request({
      Authorization: 'Bearer admin-token',
      'Idempotency-Key': eventId,
    }))
    const body = await response.json() as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ seq: 9, eventId, duplicate: false, invalidated: true })
    expect(authorityBump).toHaveBeenCalledWith('/api/products/1', eventId)
    expect(fetchSpy).toHaveBeenCalledWith('https://signal.example/gossip-seed', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ key: '/api/products/1', seq: 9, eventId, originNodeId: 'server' }),
    }))
  })
})
