import { describe, expect, it, vi } from 'vitest'
import { decodeProof } from '../crypto/publisher-proof.js'
import { PROOF_REUSE_MS, snapshotEnvelope } from './snapshot-envelope.js'

const keyBytes = new Uint8Array(32).fill(9)
const base = { path: '/api/products/1', seq: 4, keyBytes, keyId: 'aes-test' }

describe('snapshot envelope determinism (renewal depends on it)', () => {
  it('yields identical ciphertext, IV and digest regardless of payload key order or call time', async () => {
    const a = await snapshotEnvelope({ ...base, payload: { id: '1', name: 'x', nested: { b: 1, a: 2 } } })
    const b = await snapshotEnvelope({ ...base, payload: { nested: { a: 2, b: 1 }, name: 'x', id: '1' } })
    expect(b.ciphertext).toBe(a.ciphertext)
    expect(b.iv).toBe(a.iv)
    expect(decodeProof(b.proof)!.digest).toBe(decodeProof(a.proof)!.digest)
    expect(b.proof).toBe(a.proof) // inside the reuse window the signature is shared
  })

  it('signs a new proof once the reuse window passes, over the same bytes', async () => {
    const path = '/api/products/window'
    const a = await snapshotEnvelope({ ...base, path, payload: { id: 'w' } })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(a.validatedAt + PROOF_REUSE_MS + 1)
    const b = await snapshotEnvelope({ ...base, path, payload: { id: 'w' } })
    clock.mockRestore()
    expect(b.validatedAt).toBeGreaterThan(a.validatedAt)
    expect(b.ciphertext).toBe(a.ciphertext)
    expect(decodeProof(b.proof)!.digest).toBe(decodeProof(a.proof)!.digest)
    // Reuse never extends the signed window: validUntil is fixed relative to validatedAt.
    expect(decodeProof(a.proof)!.validUntil - decodeProof(a.proof)!.validatedAt).toBe(5_000)
  })

  it('never reuses a proof across a changed payload at the same version', async () => {
    const path = '/api/products/changed'
    const a = await snapshotEnvelope({ ...base, path, payload: { id: 'c', v: 1 } })
    const b = await snapshotEnvelope({ ...base, path, payload: { id: 'c', v: 2 } })
    expect(b.iv).not.toBe(a.iv)
    expect(decodeProof(b.proof)!.digest).not.toBe(decodeProof(a.proof)!.digest)
  })

  it('stays identical across a fresh module instance, as on another serverless instance', async () => {
    const first = await snapshotEnvelope({ ...base, payload: { id: '1' } })
    vi.resetModules()
    const again = await (await import('./snapshot-envelope.js')).snapshotEnvelope({ ...base, payload: { id: '1' } })
    expect(again.ciphertext).toBe(first.ciphertext)
    expect(decodeProof(again.proof)!.digest).toBe(decodeProof(first.proof)!.digest)
  })

  it('shares one signature across a concurrent burst for the same version', async () => {
    const realSign = crypto.subtle.sign.bind(crypto.subtle)
    let ecdsa = 0
    const spy = vi.spyOn(crypto.subtle, 'sign').mockImplementation((...args: Parameters<typeof realSign>) => {
      if ((typeof args[0] === 'string' ? args[0] : args[0].name) === 'ECDSA') ecdsa++
      return realSign(...args)
    })
    const burst = await Promise.all(Array.from({ length: 100 }, () =>
      snapshotEnvelope({ ...base, path: '/api/products/burst', payload: { id: 'b' } })))
    spy.mockRestore()
    expect(ecdsa).toBe(1)
    expect(new Set(burst.map(e => e.proof)).size).toBe(1)
  })
})
