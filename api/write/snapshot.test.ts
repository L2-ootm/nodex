import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemorySequenceAuthority } from '../../src/server/in-memory-sequence-authority.js'
import { app as writer } from './[...path].js'
import { app as reader } from '../products/[id].js'
import { decodeProof, verifyProof, PROOF_HEADER } from '../../src/crypto/publisher-proof.js'
import { getPublisher } from '../../src/server/publisher.js'
import { buildPayloadAad } from '../../src/crypto/crypto.js'

const state = vi.hoisted(() => ({ authority: null as InMemorySequenceAuthority | null }))
vi.mock('../../src/server/sequence-authority-provider.js', () => ({ getSequenceAuthority: () => state.authority }))
afterEach(() => vi.unstubAllEnvs())

describe('write/read snapshot journey', () => {
  it('requires admin and returns signed actual payload after an atomic write', async () => {
    vi.stubEnv('NODEX_BETA_ADMIN_TOKENS', 'test-admin')
    vi.stubEnv('NODEX_SESSION_KEY_HEX', 'ab'.repeat(32))
    state.authority = new InMemorySequenceAuthority('00000000-0000-4000-8000-000000000001')
    const key = '/api/products/1', id = crypto.randomUUID()
    const command = { baseVersion: 0, data: { id: '1', price: 18.5, name: 'Updated snapshot' } }
    const write = (data = command) => writer.request('/api/write' + key, { method: 'POST',
      headers: { Authorization: 'Bearer test-admin', 'Idempotency-Key': id, 'Content-Type': 'application/json' },
      body: JSON.stringify(data) })
    expect((await writer.request('/api/write' + key, { method: 'POST' })).status).toBe(401)
    expect((await write()).status).toBe(200)
    expect(await (await write()).json()).toMatchObject({ duplicate: true, version: 1, invalidation: 'queued' })
    expect((await write({ ...command, data: { ...command.data, price: 99 } })).status).toBe(400)
    const encrypted = await reader.request(key)
    const body = await encrypted.text()
    const proof = decodeProof(encrypted.headers.get(PROOF_HEADER)!)!
    expect(await verifyProof(proof, (await getPublisher()).identity, key, 'content', body)).toBe(true)
    const aes = await crypto.subtle.importKey('raw', Buffer.from('ab'.repeat(32), 'hex'), 'AES-GCM', false, ['decrypt'])
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(proof.iv, 'base64'),
      additionalData: Uint8Array.from(buildPayloadAad(key, proof.version, proof.encryptionKeyId, proof.validatedAt)).buffer },
      aes, Buffer.from(body, 'base64'))
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual(command.data)
    const conflict = await writer.request('/api/write' + key, { method: 'POST', headers: {
      Authorization: 'Bearer test-admin', 'Idempotency-Key': crypto.randomUUID(), 'Content-Type': 'application/json',
    }, body: JSON.stringify(command) })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ currentVersion: 1 })
  })
})
