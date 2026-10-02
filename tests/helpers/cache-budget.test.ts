import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CACHE_MAX_BYTES } from '../../src/shared/config.js'
const state = vi.hoisted(() => ({ meta: new Map<string, any>(), bodies: new Map<string, Response>(), failWrite: false }))
vi.mock('../../src/sw/idb.js', () => ({ getDb: async () => ({
  get: async (_s: string, key: string) => state.meta.get(key),
  getAll: async () => [...state.meta.values()],
  delete: async (_s: string, key: string) => state.meta.delete(key),
  put: async (_s: string, value: any) => { if (state.failWrite) throw new Error('quota'); state.meta.set(value.path, value) },
}) }))
import { putCachedEntry } from '../../src/sw/cache.js'
beforeEach(() => {
  state.meta.clear(); state.bodies.clear(); state.failWrite = false
  vi.stubGlobal('self', { caches: { open: async () => ({
    put: async (key: string, body: Response) => { state.bodies.set(key, body) },
    delete: async (key: string) => state.bodies.delete(key),
  }) } })
})
afterEach(() => vi.unstubAllGlobals())
it('accounts actual bytes and evicts as many entries as needed despite a false length header', async () => {
  for (const key of ['/api/products/1', '/api/products/2', '/api/products/3']) {
    state.meta.set(key, { path: key, seq: 1, byte_size: CACHE_MAX_BYTES / 3, accessed_at: 1 })
    state.bodies.set(key, new Response('old'))
  }
  await putCachedEntry('/api/products/4', new Response(new Uint8Array(CACHE_MAX_BYTES / 2),
    { headers: { 'Content-Length': '1' } }), 1)
  expect(state.meta.size).toBe(2)
  expect(state.meta.get('/api/products/4').byte_size).toBe(CACHE_MAX_BYTES / 2)
  expect([...state.meta.values()].reduce((n, m) => n + m.byte_size, 0)).toBeLessThanOrEqual(CACHE_MAX_BYTES)
})
it('rejects oversized bodies and never replaces a newer version with an older version', async () => {
  await putCachedEntry('/api/products/1', new Response(new Uint8Array(CACHE_MAX_BYTES + 1)), 1)
  expect(state.bodies.size).toBe(0)
  await Promise.all([putCachedEntry('/api/products/1', new Response('new'), 2),
    putCachedEntry('/api/products/1', new Response('old'), 1)])
  expect(await state.bodies.get('/api/products/1')!.text()).toBe('new')
  expect(state.meta.get('/api/products/1').seq).toBe(2)
})
it('removes unaccounted bodies when metadata persistence fails', async () => {
  state.failWrite = true
  await putCachedEntry('/api/products/1', new Response('body'), 1)
  expect(state.bodies.size).toBe(0)
})
