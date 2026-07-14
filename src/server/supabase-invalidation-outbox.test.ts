import { describe, expect, it, vi } from 'vitest'
import { InvalidationOutboxInputError, InvalidationOutboxUnavailableError } from './invalidation-outbox.js'
import { SupabaseInvalidationOutbox, type OutboxRpcClient } from './supabase-invalidation-outbox.js'

const tenantId = '018f5b79-24c1-7a63-abfd-46a8c5ae23e7'
const workerId = '10000000-0000-4000-8000-000000000001'
const eventId = '20000000-0000-4000-8000-000000000001'

function clientResult(data: unknown, error: { message?: string } | null = null): OutboxRpcClient {
  return { rpc: vi.fn().mockResolvedValue({ data, error }) }
}

describe('SupabaseInvalidationOutbox adapter', () => {
  it('strictly parses claimed events and sends bounded lease parameters', async () => {
    const client = clientResult([{
      event_id: eventId,
      resource_key: '/api/products/1',
      seq: '7',
      sequence_updated_at: '2026-07-14T01:00:00.000Z',
      attempts: 1,
    }])
    const outbox = new SupabaseInvalidationOutbox(client, tenantId)

    await expect(outbox.claim(workerId, 25, 30_000)).resolves.toEqual([{
      tenantId,
      eventId,
      resourceKey: '/api/products/1',
      seq: 7,
      updatedAt: Date.parse('2026-07-14T01:00:00.000Z'),
      attempts: 1,
    }])
    expect(client.rpc).toHaveBeenCalledWith('nodex_claim_sequence_outbox', {
      p_tenant_id: tenantId,
      p_worker_id: workerId,
      p_limit: 25,
      p_lease_seconds: 30,
    })
  })

  it('acknowledges and retries only through the lease owner RPCs', async () => {
    const client: OutboxRpcClient = {
      rpc: vi.fn()
        .mockResolvedValueOnce({ data: [{ acknowledged: true }], error: null })
        .mockResolvedValueOnce({ data: [{ retried: true }], error: null }),
    }
    const outbox = new SupabaseInvalidationOutbox(client, tenantId)

    await expect(outbox.acknowledge(eventId, workerId)).resolves.toBe(true)
    await expect(outbox.retry(eventId, workerId, 2_000, 'offline')).resolves.toBe(true)
    expect(client.rpc).toHaveBeenLastCalledWith('nodex_retry_sequence_outbox', {
      p_tenant_id: tenantId,
      p_event_id: eventId,
      p_worker_id: workerId,
      p_delay_ms: 2_000,
      p_error: 'offline',
    })
  })

  it('fails closed on malformed rows, transport errors, and invalid bounds', async () => {
    const malformed = new SupabaseInvalidationOutbox(clientResult([{
      event_id: eventId,
      resource_key: '/api/products/1',
      seq: '9007199254740992',
      sequence_updated_at: '2026-07-14T01:00:00.000Z',
      attempts: 1,
    }]), tenantId)
    await expect(malformed.claim(workerId, 1, 30_000)).rejects.toBeInstanceOf(InvalidationOutboxUnavailableError)

    const unavailable = new SupabaseInvalidationOutbox(clientResult(null, { message: 'offline' }), tenantId)
    await expect(unavailable.claim(workerId, 1, 30_000)).rejects.toBeInstanceOf(InvalidationOutboxUnavailableError)
    await expect(unavailable.claim(workerId, 101, 30_000)).rejects.toBeInstanceOf(InvalidationOutboxInputError)
  })
})
