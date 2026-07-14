import { describe, expect, it, vi } from 'vitest'
import { InMemoryInvalidationOutbox } from './in-memory-invalidation-outbox.js'
import {
  createInMemorySequenceState,
  InMemorySequenceAuthority,
} from './in-memory-sequence-authority.js'
import type { InvalidationSink } from './invalidation-outbox.js'
import { runOutboxBatch } from './outbox-worker.js'

const tenantId = '018f5b79-24c1-7a63-abfd-46a8c5ae23e7'
const workerId = '10000000-0000-4000-8000-000000000001'
const uuid = (value: number) => `20000000-0000-4000-8000-${String(value).padStart(12, '0')}`

describe('outbox worker conformance', () => {
  it('delivers and acknowledges a claimed batch', async () => {
    const state = createInMemorySequenceState()
    const authority = new InMemorySequenceAuthority(tenantId, state, () => 1_000)
    await authority.bump('/api/products/1', uuid(1))
    await authority.bump('/api/products/1', uuid(2))
    const outbox = new InMemoryInvalidationOutbox(tenantId, state, () => 1_000)
    const deliver = vi.fn().mockResolvedValue(undefined)

    await expect(runOutboxBatch(outbox, { deliver }, { workerId })).resolves.toEqual({
      claimed: 2,
      delivered: 2,
      retried: 0,
      leaseLost: 0,
    })
    expect(deliver).toHaveBeenCalledTimes(2)
    expect([...state.outbox.values()].every((event) => event.deliveredAt === 1_000)).toBe(true)
  })

  it('releases failed deliveries with exponential retry delay', async () => {
    let now = 1_000
    const state = createInMemorySequenceState()
    const authority = new InMemorySequenceAuthority(tenantId, state, () => now)
    await authority.bump('/api/products/1', uuid(3))
    const outbox = new InMemoryInvalidationOutbox(tenantId, state, () => now)
    const sink: InvalidationSink = { deliver: vi.fn().mockRejectedValue(new Error('signaling offline')) }

    await expect(runOutboxBatch(outbox, sink, { workerId, baseRetryMs: 2_000 })).resolves.toMatchObject({
      claimed: 1,
      retried: 1,
    })
    const event = [...state.outbox.values()][0]
    expect(event.availableAt).toBe(3_000)
    expect(event.lastError).toBe('signaling offline')

    now = 2_999
    await expect(outbox.claim(workerId, 1, 30_000)).resolves.toEqual([])
    now = 3_000
    await expect(outbox.claim(workerId, 1, 30_000)).resolves.toMatchObject([{ attempts: 2 }])
  })

  it('prevents another worker from claiming an active lease', async () => {
    const state = createInMemorySequenceState()
    const authority = new InMemorySequenceAuthority(tenantId, state, () => 1_000)
    await authority.bump('/api/products/1', uuid(4))
    const outbox = new InMemoryInvalidationOutbox(tenantId, state, () => 1_000)

    await expect(outbox.claim(workerId, 1, 30_000)).resolves.toHaveLength(1)
    await expect(outbox.claim('10000000-0000-4000-8000-000000000002', 1, 30_000)).resolves.toEqual([])
  })
})
