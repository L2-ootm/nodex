import { describe, expect, it, vi } from 'vitest'
import { decodeProof } from '../crypto/publisher-proof.js'
import { snapshotEnvelope } from './snapshot-envelope.js'

const keyBytes = new Uint8Array(32).fill(9)
const base = { path: '/api/products/1', seq: 4, keyBytes, keyId: 'aes-test' }

describe('snapshot envelope determinism (renewal depends on it)', () => {
  it('yields identical ciphertext, IV and digest regardless of payload key order or call time', async () => {
    const a = await snapshotEnvelope({ ...base, payload: { id: '1', name: 'x', nested: { b: 1, a: 2 } } })
    await new Promise(r => setTimeout(r, 3))
    const b = await snapshotEnvelope({ ...base, payload: { nested: { a: 2, b: 1 }, name: 'x', id: '1' } })
    expect(b.ciphertext).toBe(a.ciphertext)
    expect(b.iv).toBe(a.iv)
    expect(decodeProof(b.proof)!.digest).toBe(decodeProof(a.proof)!.digest)
    expect(b.validatedAt).toBeGreaterThan(a.validatedAt)
  })

  it('stays identical across a fresh module instance, as on another serverless instance', async () => {
    const first = await snapshotEnvelope({ ...base, payload: { id: '1' } })
    vi.resetModules()
    const again = await (await import('./snapshot-envelope.js')).snapshotEnvelope({ ...base, payload: { id: '1' } })
    expect(again.ciphertext).toBe(first.ciphertext)
    expect(decodeProof(again.proof)!.digest).toBe(decodeProof(first.proof)!.digest)
  })
})
