import { describe, expect, it } from 'vitest'
import { SequenceAuthorityInputError, SequenceAuthorityUnavailableError } from './sequence-authority.js'
import {
  createInMemorySequenceState,
  InMemorySequenceAuthority,
} from './in-memory-sequence-authority.js'

const tenantA = '018f5b79-24c1-7a63-abfd-46a8c5ae23e7'
const tenantB = '018f5b79-24c1-7a63-abfd-46a8c5ae23e8'
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`

describe('InMemorySequenceAuthority conformance reference', () => {
  it('fails closed when a resource has no authoritative head', async () => {
    const authority = new InMemorySequenceAuthority(tenantA)
    await expect(authority.read('/api/products/1')).rejects.toBeInstanceOf(SequenceAuthorityUnavailableError)
  })

  it('produces unique contiguous versions under concurrent commands', async () => {
    const state = createInMemorySequenceState()
    const authority = new InMemorySequenceAuthority(tenantA, state, () => 1_000_000)
    const bumps = await Promise.all(
      Array.from({ length: 50 }, (_, index) => authority.bump('/api/products/1', uuid(index + 1))),
    )

    expect(bumps.map((bump) => bump.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    )
    await expect(authority.read('/api/products/1')).resolves.toEqual({ seq: 50, updatedAt: 1_000_000 })
    expect(state.outbox.size).toBe(50)
  })

  it('deduplicates concurrent retries of one logical command', async () => {
    const state = createInMemorySequenceState()
    const authority = new InMemorySequenceAuthority(tenantA, state, () => 1_000_000)
    const idempotencyKey = uuid(100)
    const bumps = await Promise.all(
      Array.from({ length: 50 }, () => authority.bump('/api/products/1', idempotencyKey)),
    )

    expect(new Set(bumps.map((bump) => bump.seq))).toEqual(new Set([1]))
    expect(bumps.filter((bump) => !bump.duplicate)).toHaveLength(1)
    expect(state.outbox.size).toBe(1)
  })

  it('isolates identical resource keys across tenants', async () => {
    const state = createInMemorySequenceState()
    const authorityA = new InMemorySequenceAuthority(tenantA, state, () => 1_000_000)
    const authorityB = new InMemorySequenceAuthority(tenantB, state, () => 1_000_000)
    await authorityA.bump('/api/products/1', uuid(200))
    await authorityA.bump('/api/products/1', uuid(201))
    await authorityB.bump('/api/products/1', uuid(200))

    await expect(authorityA.read('/api/products/1')).resolves.toMatchObject({ seq: 2 })
    await expect(authorityB.read('/api/products/1')).resolves.toMatchObject({ seq: 1 })
  })

  it('rejects reuse of an idempotency key for another resource', async () => {
    const authority = new InMemorySequenceAuthority(tenantA)
    const idempotencyKey = uuid(300)
    await authority.bump('/api/products/1', idempotencyKey)
    await expect(authority.bump('/api/products/2', idempotencyKey)).rejects.toBeInstanceOf(SequenceAuthorityInputError)
  })
})
