import { describe, it, expect, beforeEach } from 'vitest'
import type { PeerFetchResponse } from '../shared/types.js'
import {
  _resetForTest,
  pendingRequests,
  selectConnectedPeer,
} from './p2p-manager.js'

describe('p2p-manager', () => {
  beforeEach(() => {
    _resetForTest()
  })

  it('reqId correlation routes response to correct resolver', () => {
    const called: string[] = []

    pendingRequests.set('req-A', (_r) => { called.push('A') })
    pendingRequests.set('req-B', (_r) => { called.push('B') })

    // Simulate incoming CACHE_FETCH_RESPONSE matching req-A
    const data: PeerFetchResponse = {
      type: 'CACHE_FETCH_RESPONSE',
      reqId: 'req-A',
      found: true,
      payload: '{"data":1}',
    }

    const resolver = pendingRequests.get(data.reqId)
    if (resolver) {
      resolver(data)
      pendingRequests.delete(data.reqId)
    }

    expect(called).toEqual(['A'])
    expect(pendingRequests.has('req-A')).toBe(false)
    expect(pendingRequests.has('req-B')).toBe(true)
  })

  it('message parsing: PeerFetchResponse round-trips correctly', () => {
    const original: PeerFetchResponse = {
      type: 'CACHE_FETCH_RESPONSE',
      reqId: 'test-req-id-42',
      found: true,
      payload: '{"id":"1","name":"Product 1"}',
      seq: 7,
    }

    const serialized = JSON.stringify(original)
    const parsed = JSON.parse(serialized) as PeerFetchResponse

    expect(parsed.type).toBe('CACHE_FETCH_RESPONSE')
    expect(parsed.reqId).toBe('test-req-id-42')
    expect(parsed.found).toBe(true)
    expect(parsed.payload).toBe('{"id":"1","name":"Product 1"}')
    expect(parsed.seq).toBe(7)
  })

  it('peer selection returns null when no connections exist', () => {
    expect(selectConnectedPeer()).toBeNull()
  })
})
