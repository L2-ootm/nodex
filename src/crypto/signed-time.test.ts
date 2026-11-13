import { describe, expect, it } from 'vitest'
import { signTime, verifyTime, type PublisherIdentity } from './publisher-proof.js'
import { app } from '../server/mock-api.js'

async function authority() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const identity: PublisherIdentity = { tenant: 't', epoch: 'e', keyId: 'k',
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey) }
  const stamp = (nonce: string, serverMs = 1_700_000_000_000) =>
    signTime({ format: 1, nonce, serverMs, tenant: 't', epoch: 'e', signingKeyId: 'k' }, pair.privateKey)
  return { identity, stamp }
}
const nonce = 'abcdefghijklmnop12345678'

describe('signed time', () => {
  it('verifies for the nonce it was issued for', async () => {
    const { identity, stamp } = await authority()
    expect(await verifyTime(await stamp(nonce), identity, nonce)).toBe(true)
  })

  it('rejects a replay for another nonce, a tampered time, a short nonce and another authority', async () => {
    const { identity, stamp } = await authority()
    const good = await stamp(nonce)
    expect(await verifyTime(good, identity, 'zzzzzzzzzzzzzzzz12345678')).toBe(false)
    expect(await verifyTime({ ...good, serverMs: good.serverMs - 60_000 }, identity, nonce)).toBe(false)
    expect(await verifyTime(await stamp('short'), identity, 'short')).toBe(false)
    expect(await verifyTime(good, { ...identity, epoch: 'other' }, nonce)).toBe(false)
    expect(await verifyTime(good, (await authority()).identity, nonce)).toBe(false)
  })

  it('mock API signs the caller nonce, refuses malformed nonces and never allows caching', async () => {
    const identity = await (await app.request('/api/publisher-key')).json() as PublisherIdentity
    const res = await app.request(`/api/time?nonce=${nonce}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await verifyTime(await res.json(), identity, nonce)).toBe(true)
    expect((await app.request('/api/time?nonce=x')).status).toBe(400)
    expect((await app.request('/api/time')).status).toBe(400)
  })
})
