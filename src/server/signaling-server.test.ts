import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SIGNALING_ROOM } from '../shared/config.js'
import { getPeers, peers, rooms } from './signaling-server.js'

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
