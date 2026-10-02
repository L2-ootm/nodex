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

  it('commits one concurrent snapshot, rejects future bases and preserves payload on bumps', async () => {
    const state = createInMemorySequenceState()
    const authority = new InMemorySequenceAuthority(tenantA, state, () => 1000)
    const key = '/api/products/1'
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      authority.write(key, uuid(400 + i), 0, { price: i })))
    expect(results.filter(result => !('conflict' in result))).toHaveLength(1)
    expect(state.outbox.size).toBe(1)
    await expect(authority.write(key, uuid(500), 9, {})).resolves.toEqual({ conflict: true, currentVersion: 1 })
    await authority.bump(key, uuid(501))
    const read = await authority.read(key)
    expect(read).toMatchObject({ seq: 2, payload: { price: 0 } })
    read.payload!['price'] = 99
    expect((await authority.read(key)).payload).toEqual({ price: 0 })
  })

  it('binds retry identity to command kind, base and payload', async () => {
    const authority = new InMemorySequenceAuthority(tenantA)
    const key = '/api/products/1', identity = uuid(600)
    await authority.write(key, identity, 0, { a: 1, nested: { b: 2, c: 3 } })
    await expect(authority.write(key, identity, 0, { nested: { c: 3, b: 2 }, a: 1 })).resolves.toMatchObject({ duplicate: true, seq: 1 })
    await expect(authority.write(key, identity, 0, { a: 2 })).rejects.toBeInstanceOf(SequenceAuthorityInputError)
    await expect(authority.write(key, identity, 1, { a: 1 })).rejects.toBeInstanceOf(SequenceAuthorityInputError)
    await expect(authority.bump(key, identity)).rejects.toBeInstanceOf(SequenceAuthorityInputError)
  })
})
