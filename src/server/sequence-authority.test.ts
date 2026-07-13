import { describe, expect, it, vi } from 'vitest'
import {
  createSequenceAuthorityFromEnv,
  SequenceAuthorityInputError,
  SequenceAuthorityUnavailableError,
  SupabaseSequenceAuthority,
  type SequenceRpcClient,
} from './sequence-authority.js'

const tenantId = '018f5b79-24c1-7a63-abfd-46a8c5ae23e7'

function clientResult(data: unknown, error: { message?: string } | null = null): SequenceRpcClient {
  return { rpc: vi.fn().mockResolvedValue({ data, error }) }
}

describe('SupabaseSequenceAuthority', () => {
  it('reads a strict tenant-scoped sequence record', async () => {
    const client = clientResult([{ seq: '7', updated_at: '2026-07-13T18:00:00.000Z' }])
    const authority = new SupabaseSequenceAuthority(client, tenantId)

    await expect(authority.read('/api/products/1')).resolves.toEqual({
      seq: 7,
      updatedAt: Date.parse('2026-07-13T18:00:00.000Z'),
    })
    expect(client.rpc).toHaveBeenCalledWith('nodex_read_sequence', {
      p_tenant_id: tenantId,
      p_resource_key: '/api/products/1',
    })
  })

  it('returns an idempotent bump result and event identity', async () => {
    const eventId = '018f5b79-24c1-7a63-abfd-46a8c5ae23e7'
    const client = clientResult([{
      seq: 8,
      updated_at: '2026-07-13T18:00:01.000Z',
      event_id: eventId,
      duplicate: true,
    }])
    const authority = new SupabaseSequenceAuthority(client, tenantId)

    await expect(authority.bump('/api/products/1', eventId)).resolves.toEqual({
      seq: 8,
      updatedAt: Date.parse('2026-07-13T18:00:01.000Z'),
      eventId,
      duplicate: true,
    })
  })

  it('fails closed on RPC errors and malformed or unsafe rows', async () => {
    const cases: SequenceRpcClient[] = [
      clientResult(null, { message: 'database unavailable' }),
      clientResult([]),
      clientResult([{ seq: 0, updated_at: '2026-07-13T18:00:00.000Z' }]),
      clientResult([{ seq: '9007199254740992', updated_at: '2026-07-13T18:00:00.000Z' }]),
      clientResult([{ seq: 1, updated_at: 'not-a-time' }]),
      clientResult([{ seq: 1, updated_at: '2026-07-13T18:00:00.000Z' }, { seq: 2, updated_at: '2026-07-13T18:00:01.000Z' }]),
    ]

    for (const client of cases) {
      const authority = new SupabaseSequenceAuthority(client, tenantId)
      await expect(authority.read('/api/products/1')).rejects.toBeInstanceOf(SequenceAuthorityUnavailableError)
    }
  })

  it('rejects uncanonical keys and invalid idempotency keys before RPC', async () => {
    const client = clientResult([])
    const authority = new SupabaseSequenceAuthority(client, tenantId)
    await expect(authority.read('api/products/1')).rejects.toBeInstanceOf(SequenceAuthorityInputError)
    await expect(authority.read('/api//products/1')).rejects.toBeInstanceOf(SequenceAuthorityInputError)
    await expect(authority.bump('/api/products/1', 'not-a-uuid')).rejects.toBeInstanceOf(SequenceAuthorityInputError)
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('normalizes thrown transport errors to authority-unavailable', async () => {
    const client: SequenceRpcClient = { rpc: vi.fn().mockRejectedValue(new Error('network down')) }
    const authority = new SupabaseSequenceAuthority(client, tenantId)
    await expect(authority.read('/api/products/1')).rejects.toBeInstanceOf(SequenceAuthorityUnavailableError)
  })

  it('requires server-owned tenant and service-role configuration', () => {
    expect(() => createSequenceAuthorityFromEnv({})).toThrow(SequenceAuthorityUnavailableError)
    expect(() => createSequenceAuthorityFromEnv({
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SECRET_KEY: 'secret-key',
    })).toThrow(SequenceAuthorityUnavailableError)
  })
})
