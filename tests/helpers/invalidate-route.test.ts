import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '../../apps/beta-suite/app/api/invalidate/[...path]/route.js'
const eventId = '018f5b79-24c1-7a63-abfd-46a8c5ae23e7'
const request = (headers: Record<string,string> = {}) => new NextRequest('http://localhost/api/invalidate/products/1', { method: 'POST', headers })
const invoke = (req: NextRequest) => POST(req, { params: Promise.resolve({ path: ['products','1'] }) })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
describe('frontend invalidation proxy', () => {
  it('rejects missing authorization and malformed retry identity before forwarding', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    expect((await invoke(request())).status).toBe(401)
    expect((await invoke(request({ Authorization: 'Bearer token' }))).status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('preserves API authorization failure and committed queued result', async () => {
    vi.stubEnv('NEXT_PUBLIC_NODEX_BETA_API_URL','https://api.example')
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{"error":"unauthorized"}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ seq: 9, eventId, invalidation: 'queued' })))
    vi.stubGlobal('fetch', fetch)
    const headers = { Authorization: 'Bearer token', 'Idempotency-Key': eventId }
    expect((await invoke(request(headers))).status).toBe(401)
    const response = await invoke(request(headers))
    expect(await response.json()).toMatchObject({ seq: 9, eventId, invalidation: 'queued' })
    expect(String(fetch.mock.calls[0]![0])).toBe('https://api.example/api/invalidate/api/products/1')
    expect(fetch.mock.calls[0]![1]).toMatchObject({ headers, method: 'POST', cache: 'no-store' })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
  it('fails closed on upstream transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const response = await invoke(request({ Authorization: 'Bearer token', 'Idempotency-Key': eventId }))
    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('1')
  })
})
