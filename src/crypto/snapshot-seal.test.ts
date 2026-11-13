import { describe, expect, it } from 'vitest'
import { buildPayloadAad, decrypt } from './crypto.js'
import { sealSnapshot } from './snapshot-seal.js'

const keyBytes = new Uint8Array(32).fill(7)
const base = { keyBytes, keyId: 'aes-test', epoch: 'e1', path: '/api/products/1', seq: 3, plaintext: '{"a":1}' }
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))

describe('deterministic snapshot sealing', () => {
  it('is byte-identical for the same resource, version and plaintext', async () => {
    const [a, b] = await Promise.all([sealSnapshot(base), sealSnapshot(base)])
    expect(a).toEqual(b)
  })

  it('uses a different IV when the plaintext, version, epoch or resource changes', async () => {
    const ivs = new Set((await Promise.all([
      sealSnapshot(base), sealSnapshot({ ...base, plaintext: '{"a":2}' }), sealSnapshot({ ...base, seq: 4 }),
      sealSnapshot({ ...base, epoch: 'e2' }), sealSnapshot({ ...base, path: '/api/products/2' }),
    ])).map(s => s.iv))
    expect(ivs.size).toBe(5)
  })

  it('decrypts only with the matching resource, version and key id in the AAD', async () => {
    const { ciphertext, iv } = await sealSnapshot(base)
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt'])
    const open = (aad: Uint8Array) => decrypt(unb64(ciphertext), unb64(iv), key, aad)
    expect(new TextDecoder().decode(await open(buildPayloadAad(base.path, 3, 'aes-test')))).toBe('{"a":1}')
    await expect(open(buildPayloadAad(base.path, 4, 'aes-test'))).rejects.toThrow()
    await expect(open(buildPayloadAad('/api/products/2', 3, 'aes-test'))).rejects.toThrow()
    await expect(open(buildPayloadAad(base.path, 3, 'other'))).rejects.toThrow()
  })
})
