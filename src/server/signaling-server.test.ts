import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SIGNALING_ROOM } from '../shared/config.js'
import { app, getPeers, peers, rooms } from './signaling-server.js'

describe('signaling room registry', () => {
  beforeEach(() => {
    rooms.clear()
    peers.clear()
    rooms.set(DEFAULT_SIGNALING_ROOM, peers)
  })

  it('returns the default peers map for omitted or blank rooms', () => {
    expect(getPeers()).toBe(peers)
    expect(getPeers('   ')).toBe(peers)
  })

  it('keeps non-default rooms isolated from the default peers map', () => {
    const roomA = getPeers('phase6-a')
    const roomB = getPeers('phase6-b')

    roomA.set('node-a', { readyState: 1 } as never)
    roomB.set('node-b', { readyState: 1 } as never)
    peers.set('node-default', { readyState: 1 } as never)

    expect(roomA).not.toBe(roomB)
    expect(roomA).not.toBe(peers)
    expect([...roomA.keys()]).toEqual(['node-a'])
    expect([...roomB.keys()]).toEqual(['node-b'])
    expect([...peers.keys()]).toEqual(['node-default'])
  })

  it('reuses the same map for repeated room lookups', () => {
    const first = getPeers('phase6-demo')
    const second = getPeers('phase6-demo')

    expect(second).toBe(first)
  })
})

describe('signaling invalidation seed', () => {
  afterEach(() => {
    delete process.env['NODEX_SIGNALING_SEED_TOKEN']
    delete process.env['NODEX_TENANT_ID']
  })

  it('requires the configured server-to-server token', async () => {
    process.env['NODEX_SIGNALING_SEED_TOKEN'] = 'seed-secret'
    const unauthorized = await app.request('/gossip-seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: '/api/products/1', seq: 1 }),
    })
    expect(unauthorized.status).toBe(401)

    const authorized = await app.request('/gossip-seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer seed-secret' },
      body: JSON.stringify({
        key: '/api/products/1',
        seq: 1,
        eventId: '20000000-0000-4000-8000-000000000001',
      }),
    })
    expect(authorized.status).toBe(200)
  })

  it('rejects unsafe keys, sequences, and event identities', async () => {
    for (const body of [
      { key: 'api/products/1', seq: 1 },
      { key: '/api/products/1', seq: 0 },
      { key: '/api/products/1', seq: 1, eventId: 'not-a-uuid' },
    ]) {
      const response = await app.request('/gossip-seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
  })

  it('rejects invalidations addressed to another tenant', async () => {
    process.env['NODEX_TENANT_ID'] = '018f5b79-24c1-7a63-abfd-46a8c5ae23e7'
    const response = await app.request('/gossip-seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: '018f5b79-24c1-7a63-abfd-46a8c5ae23e8',
        key: '/api/products/1',
        seq: 1,
      }),
    })
    expect(response.status).toBe(403)
  })
})
