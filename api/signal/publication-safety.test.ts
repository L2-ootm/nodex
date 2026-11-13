import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from './[...path].js'

const state = vi.hoisted(() => ({ read: vi.fn(), signal: vi.fn() }))
vi.mock('../../src/server/sequence-authority-provider.js', () => ({ getSequenceAuthority: () => ({ read: state.read }) }))
vi.mock('../../src/server/http-signaling-store.js', () => ({ executeSignal: state.signal }))
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('production invalidation publication', () => {
  const tenant = '10000000-0000-4000-8000-000000000001'
  async function seed(seq: number) {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('NODEX_TENANT_ID', tenant)
    vi.stubEnv('NODEX_SIGNALING_SEED_TOKEN', 'service-token')
    return app.request('/api/signal/gossip-seed', { method: 'POST', headers: {
      Authorization: 'Bearer service-token', 'Content-Type': 'application/json',
    }, body: JSON.stringify({ tenantId: tenant, key: '/api/products/1', seq, eventId: crypto.randomUUID() }) })
  }
  it('a seed service cannot sign a future version', async () => {
    state.read.mockResolvedValue({ seq: 10, updatedAt: Date.now() })
    expect((await seed(11)).status).toBe(409)
    expect(state.signal).not.toHaveBeenCalled()
  })
  it('rejects an oversized resource key before reading the authority', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('NODEX_TENANT_ID', tenant)
    vi.stubEnv('NODEX_SIGNALING_SEED_TOKEN', 'service-token')
    const res = await app.request('/api/signal/gossip-seed', { method: 'POST', headers: {
      Authorization: 'Bearer service-token', 'Content-Type': 'application/json',
    }, body: JSON.stringify({ tenantId: tenant, key: `/api/products/${'a'.repeat(201)}`, seq: 1, eventId: crypto.randomUUID() }) })
    expect(res.status).toBe(400)
    expect(state.read).not.toHaveBeenCalled()
  })
  it('fails closed when the authoritative head is unavailable', async () => {
    state.read.mockRejectedValue(new Error('database unavailable'))
    expect((await seed(1)).status).toBe(503)
    expect(state.signal).not.toHaveBeenCalled()
  })
})
