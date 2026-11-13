import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishProof, getPublisher } from '../../src/server/publisher.js'
import { PROOF_HEADER, signTime } from '../../src/crypto/publisher-proof.js'

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
// '/api/time' is answered here so a clock challenge never consumes queued origin responses.
// 'unavailable' (default) forces the origin-anchoring fallback; 'live' signs the caller's nonce;
// 'replay' returns a stamp for a different nonce, as a cached response would.
const realNow = Date.now.bind(Date)
let timeMode: 'unavailable' | 'live' | 'replay' = 'unavailable'
async function timeStub(url: string): Promise<Response | null> {
  if (!url.includes('/api/time')) return null
  if (timeMode === 'unavailable') return new Response('unavailable', { status: 503 })
  const nonce = timeMode === 'replay' ? 'A'.repeat(24) : new URL(url).searchParams.get('nonce')!
  // Server time uses the real clock even when a test skews the client's Date.now.
  const { identity, privateKey } = await getPublisher()
  return Response.json(await signTime({ format: 1, nonce, serverMs: realNow(), tenant: identity.tenant,
    epoch: identity.epoch, signingKeyId: identity.keyId }, privateKey))
}
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
  timeMode = 'unavailable'
  vi.resetModules(); vi.clearAllMocks(); state.records.clear(); state.unavailable = false; responses = []
  state.cached.mockResolvedValue(null); state.put.mockResolvedValue(undefined)
  state.metric.mockResolvedValue(undefined); state.decrypt.mockResolvedValue(new TextEncoder().encode('{}'))
  vi.stubGlobal('fetch', vi.fn(async (request: string | Request) => {
    const url = typeof request === 'string' ? request : request.url
    const time = await timeStub(url); if (time) return time
    if (url.endsWith('/api/publisher-key')) return Response.json((await getPublisher()).identity)
    return responses.shift() ?? new Response('unavailable', { status: 503 })
  }))
  await worker()
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('signed time challenge', () => {
  async function staleOrigin(ageMs: number) {
    const validatedAt = realNow() - ageMs
    const body = 'AA=='
    const proof = await publishProof({ resource: '/api/products/1', version: 1, validatedAt,
      body, iv: 'AA==', encryptionKeyId: 'test-aes' })
    return new Response(body, { headers: { 'X-Nodex-Seq': '1', 'X-Nodex-Validated-At': String(validatedAt),
      'X-Nodex-Iv': 'AA==', 'X-Nodex-Key-Id': 'test-aes', 'X-Nodex-Cache-Scope': 'public', [PROOF_HEADER]: proof } })
  }
  const productCache = () => (fetch as any).mock.calls
    .map(([r]: [Request | string]) => r).filter((r: any) => typeof r !== 'string' && r.url.endsWith('/api/products/1'))
    .map((r: Request) => r.cache)

  it('rejects an old signed first origin response once the clock is anchored by a nonce-bound stamp', async () => {
    timeMode = 'live'
    responses.push(await staleOrigin(30_000))
    expect((await read()).status).not.toBe(200)
  })

  it('still admits a fresh origin read and allows normal HTTP caching when the client clock is 60 s off', async () => {
    timeMode = 'live'
    for (const skew of [60_000, -60_000]) {
      vi.resetModules(); await worker()
      responses.push(await staleOrigin(0))
      vi.spyOn(Date, 'now').mockReturnValue(realNow() + skew)
      expect((await read()).status).toBe(200)
      vi.restoreAllMocks()
    }
    expect(productCache()).toEqual(['default', 'default'])
  })

  it('ignores a replayed stamp for a different nonce and falls back to origin anchoring', async () => {
    timeMode = 'replay'
    responses.push(await staleOrigin(0))
    expect((await read()).status).toBe(200)
    expect(productCache()).toEqual(['no-store'])
  })
})

describe('origin-calibrated freshness clock', () => {
  for (const skew of [60_000, -60_000]) {
    it(`admits a fresh origin read when the client wall clock is ${skew > 0 ? 'ahead' : 'behind'} by 60 s`, async () => {
      const response = await origin(1)
      const real = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(real + skew)
      responses.push(response)
      expect((await read()).status).toBe(200)
      vi.restoreAllMocks()
    })
  }
  // KNOWN LIMIT (characterization, flip when fixed): the first origin response after a worker start
  // sets the clock, so a validly signed old response served to that no-store request is admitted.
  it('KNOWN LIMIT: an old signed first origin response is admitted and anchors the clock in the past', async () => {
    const validatedAt = Date.now() - 30_000
    const body = 'AA=='
    const proof = await publishProof({ resource: '/api/products/1', version: 1, validatedAt,
      body, iv: 'AA==', encryptionKeyId: 'test-aes' })
    responses.push(new Response(body, { headers: {
      'X-Nodex-Seq': '1', 'X-Nodex-Validated-At': String(validatedAt), 'X-Nodex-Iv': 'AA==',
      'X-Nodex-Key-Id': 'test-aes', 'X-Nodex-Cache-Scope': 'public', [PROOF_HEADER]: proof } }))
    expect((await read()).status).toBe(200)
  })
  it('bypasses HTTP caches until anchored, then allows normal caching', async () => {
    responses.push(await origin(1), await origin(2))
    await read(); await read()
    const productCalls = (fetch as any).mock.calls
      .map(([r]: [Request | string]) => r).filter((r: any) => typeof r !== 'string' && r.url.endsWith('/api/products/1'))
    expect(productCalls.map((r: Request) => r.cache)).toEqual(['no-store', 'default'])
  })
})

describe('proof renewal for held ciphertext', () => {
  async function held(seq: number, ageMs: number, body = 'AA==') {
    const validatedAt = Date.now() - ageMs
    const proof = await publishProof({ resource: '/api/products/1', version: seq, validatedAt,
      body, iv: 'AA==', encryptionKeyId: 'test-aes' })
    return { body, validatedAt, proof, headers: {
      'X-Nodex-Seq': String(seq), 'X-Nodex-Validated-At': String(validatedAt), 'X-Nodex-Iv': 'AA==',
      'X-Nodex-Key-Id': 'test-aes', 'X-Nodex-Cache-Scope': 'public', [PROOF_HEADER]: proof } }
  }
  async function renewal(seq: number, body = 'AA==') {
    const validatedAt = Date.now()
    const proof = await publishProof({ resource: '/api/products/1', version: seq, validatedAt,
      body, iv: 'AA==', encryptionKeyId: 'test-aes' })
    return new Response(null, { status: 204, headers: { [PROOF_HEADER]: proof,
      'X-Nodex-Validated-At': String(validatedAt), 'X-Nodex-Seq': String(seq) } })
  }
  function routeFetch(renewals: Array<Response | 'fail'>) {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (request: string | Request) => {
      const url = typeof request === 'string' ? request : request.url
    const time = await timeStub(url); if (time) return time
      urls.push(url)
      if (url.endsWith('/api/publisher-key')) return Response.json((await getPublisher()).identity)
      if (url.endsWith('/api/products/1/proof')) {
        const next = renewals.shift()
        if (!next || next === 'fail') return new Response('unavailable', { status: 503 })
        return next
      }
      return responses.shift() ?? new Response('unavailable', { status: 503 })
    }))
    return urls
  }
  const serveCached = async (seq: number, ageMs: number, body?: string) => {
    const h = await held(seq, ageMs, body)
    state.cached.mockResolvedValue({ response: new Response(h.body, { headers: h.headers }), seq })
  }

  it('serves an expired cached copy after a matching renewal without refetching the payload', async () => {
    await serveCached(5, 10_000)
    const urls = routeFetch([await renewal(5)])
    const response = await read()
    expect(response.status).toBe(200)
    expect(urls.filter(u => u.endsWith('/api/products/1'))).toEqual([])
    expect(urls.some(u => u.endsWith('/api/products/1/proof'))).toBe(true)
    // The renewed proof is persisted so the next read inside the window needs no renewal.
    expect(state.put).toHaveBeenCalledTimes(1)
    const stored = state.put.mock.calls[0]![1] as Response
    expect(Number(stored.headers.get('X-Nodex-Validated-At'))).toBeGreaterThan(Date.now() - 2_000)
  })

  it('falls back to a full origin fetch when the renewal names different bytes', async () => {
    await serveCached(5, 10_000)
    responses.push(await origin(5))
    const urls = routeFetch([await renewal(5, 'AQ==')])
    expect((await read()).status).toBe(200)
    expect(urls.filter(u => u.endsWith('/api/products/1')).length).toBe(1)
  })

  it('falls back to a full origin fetch when the renewal names a newer version', async () => {
    await serveCached(5, 10_000)
    responses.push(await origin(6))
    const urls = routeFetch([await renewal(6)])
    const response = await read()
    expect(response.status).toBe(200)
    expect(response.headers.get('X-Nodex-Seq')).toBe('6')
    expect(urls.filter(u => u.endsWith('/api/products/1')).length).toBe(1)
  })

  it('never admits an expired copy when renewal is unavailable', async () => {
    await serveCached(5, 10_000)
    responses.push(await origin(7))
    const urls = routeFetch(['fail'])
    const response = await read()
    expect(response.headers.get('X-Nodex-Seq')).toBe('7')
    expect(urls.filter(u => u.endsWith('/api/products/1')).length).toBe(1)
  })

  const peerReplies = (proofs: Array<string | null>) => {
    ;(self as any).clients.matchAll = async () => proofs.map(proof => ({ postMessage: (message: any, ports: MessagePort[]) => {
      if (message.type !== 'P2P_FETCH' || message.proofOnly !== true) return
      ports[0]!.postMessage({ type: 'P2P_FETCH_RESPONSE', found: proof !== null,
        ...(proof ? { payload: JSON.stringify({ proof }) } : {}) })
    } }))
  }
  const proofOf = async (seq: number, body = 'AA==') => (await renewal(seq, body)).headers.get(PROOF_HEADER)!

  it('renews from a neighbouring peer proof without contacting origin for the proof or the payload', async () => {
    await serveCached(5, 10_000)
    peerReplies([await proofOf(5)])
    const urls = routeFetch([])
    expect((await read()).status).toBe(200)
    expect(urls.filter(u => u.endsWith('/api/products/1') || u.endsWith('/proof'))).toEqual([])
    expect(state.put).toHaveBeenCalledTimes(1) // the peer's newer proof is persisted too
  })

  it('ignores a peer proof for different bytes, an old proof, or no reply and renews from origin', async () => {
    for (const bad of [await proofOf(5, 'AQ=='), (await held(5, 10_000)).proof, null]) {
      vi.clearAllMocks(); state.cached.mockResolvedValue(null)
      await serveCached(5, 10_000)
      peerReplies([bad])
      const urls = routeFetch([await renewal(5)])
      expect((await read()).status).toBe(200)
      expect(urls.filter(u => u.endsWith('/api/products/1/proof')).length).toBe(1)
      expect(urls.filter(u => u.endsWith('/api/products/1'))).toEqual([])
    }
  })

  it('a peer proof with matching fields but a forged signature is rejected and origin renewal is used', async () => {
    await serveCached(5, 10_000)
    const good = JSON.parse(atob(await proofOf(5)))
    good.signature = good.signature.slice(0, -4) + (good.signature.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    peerReplies([btoa(JSON.stringify(good))])
    const urls = routeFetch([await renewal(5)])
    expect((await read()).status).toBe(200)
    expect(urls.filter(u => u.endsWith('/api/products/1/proof')).length).toBe(1)
    expect(urls.filter(u => u.endsWith('/api/products/1'))).toEqual([])
  })

  it('does not call the renewal route for a still-fresh copy', async () => {
    await serveCached(5, 500)
    const urls = routeFetch([])
    expect((await read()).status).toBe(200)
    expect(urls.some(u => u.endsWith('/proof'))).toBe(false)
  })
})

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
    const time = await timeStub(url); if (time) return time
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
