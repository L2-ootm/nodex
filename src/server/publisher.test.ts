import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPublisher } from './publisher.js'

afterEach(() => vi.unstubAllEnvs())

describe('production publisher configuration', () => {
  it.each([
    ['default', 'release-1'],
    ['10000000-0000-4000-8000-000000000001', ''],
    ['10000000-0000-4000-8000-000000000001', 'development'],
    ['10000000-0000-4000-8000-000000000001', 'invalid epoch'],
  ])('rejects tenant %s and epoch %s before importing keys', async (tenant, epoch) => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NODEX_PUBLISHER_PRIVATE_JWK', '{}')
    vi.stubEnv('NODEX_TENANT_ID', tenant)
    vi.stubEnv('NODEX_PUBLISHER_EPOCH', epoch)
    await expect(getPublisher()).rejects.toThrow('Publisher configuration unavailable')
  })
})
