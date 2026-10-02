import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishProof, getPublisher } from '../../src/server/publisher.js'
import { PROOF_HEADER } from '../../src/crypto/publisher-proof.js'

const state = vi.hoisted(() => ({
  records: new Map<string, any>(), cached: vi.fn(), put: vi.fn(), decrypt: vi.fn(), metric: vi.fn(),
  reset: vi.fn(), unavailable: false,
}))
vi.mock('../../src/sw/cache.js', () => ({ getCachedEntry: state.cached,
  putCachedEntry: state.put, touchAccessedAt: async () => {}, resetPublicCache: state.reset }))
vi.mock('../../src/sw/metrics.js', () => ({ emitMetric: state.metric,
  flushBuffer: async () => {}, getNodeId: async () => 'test-node' }))
vi.mock('../../src/sw/idb.js', () => ({ getDb: async () => {
  if (state.unavailable) throw new Error('storage unavailable')
  return {
  get: async (_store: string, key: string) => state.records.get(key),
  getAll: async () => [...state.records.values()],
  put: async (_store: string, value: any) => { state.records.set(value.path ?? value.key, value) },
  delete: async (_store: string, key: string) => { state.records.delete(key) },
  }
} }))
vi.mock('../../src/crypto/crypto.js', () => ({ buildPayloadAad: () => new Uint8Array(), decrypt: state.decrypt }))
let handlers: Record<string, Function[]>
let responses: Response[]
async function worker(importKey = true) {
  handlers = {}
  vi.stubGlobal('self', { location: { origin: 'https://test.example' }, performance, crypto,
    clients: { matchAll: async () => [], claim: async () => {} },
    addEventListener: (type: string, fn: Function) => { (handlers[type] ??= []).push(fn) } })
  await import('../../src/sw/sw.js')
  if (!importKey) return
  let pending!: Promise<void>
  handlers.message[0]({ data: { type: 'IMPORT_SESSION_KEY', keyId: 'test-aes', keyBytes: btoa('x'.repeat(32)) },
    ports: [], waitUntil: (p: Promise<void>) => { pending = p } })
  await pending
}
async function read(path = '/api/products/1', init?: RequestInit) {
  let result!: Promise<Response>
  handlers.fetch[0]({ request: new Request('https://test.example' + path, init),
    respondWith: (p: Promise<Response>) => { result = p } })
  return result
}
async function origin(seq: number, tampered = false) {
  const validatedAt = Date.now()
  const body = 'AA=='
  const proof = await publishProof({ resource: '/api/products/1', version: seq, validatedAt,
    body, iv: 'AA==', encryptionKeyId: 'test-aes' })
  return new Response(tampered ? 'AQ==' : body, { headers: {
    'X-Nodex-Seq': String(seq), 'X-Nodex-Validated-At': String(validatedAt),
    'X-Nodex-Iv': 'AA==', 'X-Nodex-Key-Id': 'test-aes', 'X-Nodex-Cache-Scope': 'public', [PROOF_HEADER]: proof,
  } })
}
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); state.records.clear(); state.unavailable = false; responses = []
  state.cached.mockResolvedValue(null); state.put.mockResolvedValue(undefined)
  state.metric.mockResolvedValue(undefined); state.decrypt.mockResolvedValue(new TextEncoder().encode('{}'))
  vi.stubGlobal('fetch', vi.fn(async (request: string | Request) => {
    const url = typeof request === 'string' ? request : request.url
    if (url.endsWith('/api/publisher-key')) return Response.json((await getPublisher()).identity)
    return responses.shift() ?? new Response('unavailable', { status: 503 })
  }))
  await worker()
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('verified SW read pipeline', () => {
  it('keeps verified origin reads usable with an explicit volatile guarantee when storage cannot boot', async () => {
    state.unavailable = true
    responses.push(await origin(1))
    const response = await read()
    expect(response.status).toBe(200)
    expect(response.headers.get('X-Nodex-Consistency')).toBe('origin-only-volatile')
    expect(state.cached).not.toHaveBeenCalled()
    expect(state.put).not.toHaveBeenCalled()
  })
  it('private and authenticated variants cannot poison the public version barrier', async () => {
    const privateResponse = await origin(100)
    privateResponse.headers.set('X-Nodex-Cache-Scope', 'private')
    responses.push(privateResponse, await origin(200), await origin(1))
    expect((await read()).status).toBe(200)
    expect((await read('/api/products/1', { headers: { Authorization: 'Bearer tester' } })).status).toBe(200)
    expect(state.records.has('__obs_v:/api/products/1')).toBe(false)
    expect((await read()).status).toBe(200)
    expect(state.records.get('__obs_v:/api/products/1').seq).toBe(1)
  })
  it('recovers a reader key from an authorized page after worker restart without anonymous key access', async () => {
    responses.push(await origin(10))
    expect((await read()).status).toBe(200)
    vi.resetModules(); await worker(false)
    ;(self as any).clients.matchAll = async () => [{ postMessage: (message: any, ports: MessagePort[]) => {
      if (message.type === 'GET_SESSION_KEY') ports[0]!.postMessage({ type: 'SESSION_KEY_RESPONSE',
        keyId: message.keyId, keyBytes: btoa('x'.repeat(32)) })
    } }]
    const keyEndpoint = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (request: string | Request) => {
      const url = typeof request === 'string' ? request : request.url
      if (url.endsWith('/api/publisher-key')) return Response.json((await getPublisher()).identity)
      if (url.endsWith('/api/session-key')) { keyEndpoint(); return new Response('unauthorized', { status: 401 }) }
      return responses.shift() ?? new Response('unavailable', { status: 503 })
    }))
    responses.push(await origin(11))
    const response = await read()
    expect(response.status).toBe(200)
    expect(response.headers.get('X-Nodex-Seq')).toBe('11')
    expect(keyEndpoint).not.toHaveBeenCalled()
    expect(state.records.get('__obs_v:/api/products/1').seq).toBe(11)
  })
  it('resets barriers only after a trusted authority epoch changes', async () => {
    responses.push(await origin(20))
    expect((await read()).headers.get('X-Nodex-Seq')).toBe('20')
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    vi.stubEnv('NODEX_PUBLISHER_PRIVATE_JWK', JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)))
    vi.stubEnv('NODEX_PUBLISHER_EPOCH', 'replacement-authority')
    responses.push(await origin(1))
    expect((await read()).headers.get('X-Nodex-Seq')).toBe('1')
    expect(state.reset).toHaveBeenCalledOnce()
    expect(state.records.get('__obs_v:/api/products/1').seq).toBe(1)
    responses.push(await origin(2), await origin(1), await origin(1))
    expect((await read()).status).toBe(200)
    expect((await read()).status).toBe(503)
  })
  it('caches signed globally public CORS responses', async () => {
    const response = await origin(1)
    response.headers.set('Vary', 'Origin, Accept-Encoding')
    responses.push(response)
    expect((await read()).status).toBe(200)
    expect(state.put).toHaveBeenCalledOnce()
  })
  it('does not deliver an old authority response after an overlapping epoch transition', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    state.put.mockImplementation(async (_key, _response, seq) => {
      if (seq === 20) { entered(); await gate }
    })
    responses.push(await origin(20))
    const previous = read()
    await started
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    vi.stubEnv('NODEX_PUBLISHER_PRIVATE_JWK', JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)))
    vi.stubEnv('NODEX_PUBLISHER_EPOCH', 'overlapping-replacement')
    responses.push(await origin(1))
    expect((await read()).headers.get('X-Nodex-Seq')).toBe('1')
    release()
    expect((await previous).ok).toBe(false)
    expect(state.records.get('__obs_v:/api/products/1').seq).toBe(1)
  })
  it.each(['Cookie', 'Authorization', 'Accept-Language', '*'])('excludes responses varying by %s', async vary => {
    const response = await origin(1)
    response.headers.set('Vary', vary)
    responses.push(response)
    expect((await read()).status).toBe(200)
    expect(state.put).not.toHaveBeenCalled()
  })
  it('rejects sequential origin regression', async () => {
    responses.push(await origin(10), await origin(1), await origin(1))
    expect((await read()).status).toBe(200)
    expect((await read()).status).toBe(503)
  })
  it('rejects an older overlapping completion after a newer delivery', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(r => { release = r })
    const started = new Promise<void>(r => { entered = r })
    state.put.mockImplementation(async (_key, _res, seq) => { if (seq === 1) { entered(); await gate } })
    responses.push(await origin(1), await origin(2))
    const old = read(); await started
    expect((await read()).headers.get('X-Nodex-Seq')).toBe('2')
    release()
    const late = await old
    expect(late.ok && Number(late.headers.get('X-Nodex-Seq')) < 2).toBe(false)
  })
  it('invalid signed-content hash or AES tag never promotes the barrier or cache', async () => {
    responses.push(await origin(100, true), await origin(1))
    expect((await read()).status).toBe(502)
    expect(state.put).not.toHaveBeenCalled()
    expect(state.records.has('__obs_v:/api/products/1')).toBe(false)
    expect((await read()).status).toBe(200)
    state.decrypt.mockRejectedValueOnce(new Error('invalid tag'))
    responses.push(await origin(101))
    expect((await read()).status).toBe(502)
    expect(state.records.get('__obs_v:/api/products/1').seq).toBe(1)
  })
  it('hydrates browser-session barriers without another activate event', async () => {
    responses.push(await origin(10))
    expect((await read()).status).toBe(200)
    vi.resetModules(); await worker()
    responses.push(await origin(1), await origin(1))
    expect((await read()).status).toBe(503)
  })
  it('query, auth and no-store reads bypass shared reuse', async () => {
    state.cached.mockResolvedValue({ response: await origin(1), meta: { seq: 1 } })
    responses.push(await origin(2))
    const response = await read('/api/products/1?variant=other', { cache: 'no-store', headers: { Authorization: 'Bearer secret' } })
    expect(response.headers.get('X-Nodex-Seq')).toBe('2')
    expect(state.cached).not.toHaveBeenCalled()
    expect(state.put).not.toHaveBeenCalled()
  })
  it('plaintext and unsigned ciphertext fail closed', async () => {
    responses.push(new Response('{}', { headers: { 'X-Nodex-Seq': '1', 'X-Nodex-Validated-At': String(Date.now()) } }))
    expect((await read()).status).toBe(502)
    const unsigned = await origin(1)
    unsigned.headers.delete(PROOF_HEADER)
    responses.push(unsigned)
    expect((await read()).status).toBe(502)
  })
  it('activation preserves other applications caches', async () => {
    const remove = vi.fn().mockResolvedValue(true)
    const caches = { keys: async () => ['nodex-v1', 'nodex-old', 'other-app'], delete: remove }
    ;(self as any).caches = caches
    let pending!: Promise<void>
    handlers.activate[0]({ waitUntil: (p: Promise<void>) => { pending = p } })
    await pending
    expect(remove).toHaveBeenCalledWith('nodex-old')
    expect(remove).not.toHaveBeenCalledWith('other-app')
  })
  it('unsigned gossip cannot poison the high-water mark', async () => {
    responses.push(await origin(1), await origin(1))
    let pending!: Promise<void>
    handlers.message[0]({ data: { type: 'GOSSIP_INVALIDATE', key: '/api/products/1', seq: Number.MAX_SAFE_INTEGER },
      ports: [], waitUntil: (p: Promise<void>) => { pending = p } })
    await pending
    expect((await read()).status).toBe(200)
    expect(state.records.get('__obs_v:/api/products/1').seq).toBe(1)
  })
  it('peer deadline remains active through a stalled key fetch', async () => {
    const signed = await origin(1)
    const payload = JSON.stringify({ ciphertext: await signed.text(), iv: 'AA==', keyId: 'missing', seq: 1,
      validatedAt: Number(signed.headers.get('X-Nodex-Validated-At')), proof: signed.headers.get(PROOF_HEADER) })
    vi.stubGlobal('MessageChannel', class {
      port2 = { onmessage: null as Function | null, close: vi.fn() }
      port1 = { close: vi.fn(), postMessage: (data: unknown) => { void this.port2.onmessage?.({ data }) } }
    })
    ;(self as any).clients.matchAll = async () => [{ postMessage: (_data: unknown, ports: any[]) =>
      ports[0].postMessage({ type: 'P2P_FETCH_RESPONSE', found: true, payload }) }]
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (request, init) => request === '/api/session-key'
      ? new Promise<Response>(() => {}) : originalFetch(request, init))
    responses.push(await origin(1))
    const outcome = await Promise.race([read().then(r => r.status), new Promise(r => setTimeout(() => r('timeout'), 400))])
    expect(outcome).toBe(200)
  })
})
