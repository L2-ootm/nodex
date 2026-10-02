import { beforeAll, describe, expect, it } from 'vitest'
import { contentDigest, decodeProof, encodeProof, signProof, verifyProof,
  type PublisherIdentity, type PublisherProof } from './publisher-proof.js'
import { encrypt, importKey } from './crypto.js'

let pair: CryptoKeyPair
let identity: PublisherIdentity
beforeAll(async () => {
  pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  identity = { tenant: 'tenant-a', epoch: 'epoch-a', keyId: 'publisher-a',
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey) }
})
async function published(body = 'ciphertext'): Promise<PublisherProof> {
  return signProof({ format: 1, kind: 'content', scope: 'public', tenant: identity.tenant,
    epoch: identity.epoch, signingKeyId: identity.keyId, resource: '/api/products/1',
    version: 1, validatedAt: 1_000, validUntil: 6_000, digest: await contentDigest(body),
    iv: 'iv', encryptionKeyId: 'aes-key' }, pair.privateKey)
}
describe('publisher-only authenticity', () => {
  it('invalidation survives idle polling, but expires after its bounded publication window', async () => {
    const proof = await signProof({ ...await published(), kind: 'invalidation', digest: '', iv: '', encryptionKeyId: '',
      validUntil: 121000 }, pair.privateKey)
    expect(await verifyProof(proof, identity, '/api/products/1', 'invalidation', undefined, 31000)).toBe(true)
    expect(await verifyProof(proof, identity, '/api/products/1', 'invalidation', undefined, 121000)).toBe(false)
  })
  it('verifies a canonical publication and roundtrips the transport envelope', async () => {
    const proof = await published()
    expect(decodeProof(encodeProof(proof))).toEqual(proof)
    expect(await verifyProof(proof, identity, '/api/products/1', 'content', 'ciphertext', 2_000)).toBe(true)
  })
  it('rejects changes to body, version, authorization scope, tenant, resource, epoch and expiry', async () => {
    const proof = await published()
    for (const change of [{ version: 2 }, { scope: 'private' as const }, { tenant: 'tenant-b' },
      { resource: '/api/products/2' }, { epoch: 'other' }, { validUntil: 5_999 }]) {
      expect(await verifyProof({ ...proof, ...change }, identity, '/api/products/1', 'content', 'ciphertext', 2_000)).toBe(false)
    }
    expect(await verifyProof(proof, identity, '/api/products/1', 'content', 'tampered', 2_000)).toBe(false)
    expect(await verifyProof(proof, identity, '/api/products/1', 'content', 'ciphertext', 6_000)).toBe(false)
    expect(await verifyProof(proof, identity, '/api/products/1', 'invalidation', undefined, 2_000)).toBe(false)
  })
  it('a reader holding AES credentials cannot publish with the publisher public key', async () => {
    const aes = await importKey(crypto.getRandomValues(new Uint8Array(32)))
    const forged = await encrypt(new TextEncoder().encode('{"price":0}'), aes)
    const body = btoa(Array.from(forged.ciphertext, c => String.fromCharCode(c)).join(''))
    const original = await published()
    expect(await verifyProof({ ...original, version: 999, digest: await contentDigest(body) },
      identity, '/api/products/1', 'content', body, 2_000)).toBe(false)
    await expect(signProof(original, pair.publicKey)).rejects.toThrow()
  })
  it('rejects unbounded, malformed and unsafe-integer envelopes', async () => {
    expect(decodeProof('x'.repeat(4_097))).toBeNull()
    expect(decodeProof('invalid')).toBeNull()
    expect(decodeProof(encodeProof({ ...await published(), version: Number.MAX_SAFE_INTEGER + 1 }))).toBeNull()
  })
})
