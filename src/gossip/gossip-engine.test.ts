// src/gossip/gossip-engine.test.ts
// Unit tests for LruSet and GossipEngine.
// No BroadcastChannel or browser-only APIs — runs in Node.js vitest environment.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { LruSet, GossipEngine, _resetForTest } from './gossip-engine.js'
import type { GossipMessage } from '../shared/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockDC(readyState: string = 'open'): RTCDataChannel {
  return {
    readyState,
    send: vi.fn(),
    onmessage: null,
  } as unknown as RTCDataChannel
}

function makeConnections(
  peers: Array<{ peerId: string; state: string; readyState?: string }>,
): Map<string, { gossip: RTCDataChannel; state: string }> {
  const map = new Map<string, { gossip: RTCDataChannel; state: string }>()
  for (const p of peers) {
    map.set(p.peerId, {
      gossip: makeMockDC(p.readyState ?? 'open'),
      state: p.state,
    })
  }
  return map
}

function makeMsg(overrides: Partial<GossipMessage> = {}): GossipMessage {
  return {
    type: 'GOSSIP_INVALIDATE',
    msgId: crypto.randomUUID(),
    key: '/api/products/1',
    seq: 1,
    ttl: 3,
    originNodeId: 'origin-node',
    t_invalidate: Date.now() - 10,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// LruSet tests
// ---------------------------------------------------------------------------

describe('LruSet', () => {
  beforeEach(() => {
    _resetForTest()
  })

  it('has() returns false for a key never added', () => {
    const set = new LruSet(10)
    expect(set.has('missing-key')).toBe(false)
  })

  it('has() returns true for an added key', () => {
    const set = new LruSet(10)
    set.add('key-a')
    expect(set.has('key-a')).toBe(true)
  })

  it('evicts the oldest entry when max is exceeded', () => {
    const set = new LruSet(3)
    set.add('a')
    set.add('b')
    set.add('c')
    // Adding 4th item should evict 'a' (oldest)
    set.add('d')
    expect(set.has('a')).toBe(false)
    expect(set.has('d')).toBe(true)
  })

  it('re-adding an existing item refreshes its LRU position', () => {
    const set = new LruSet(3)
    set.add('a')
    set.add('b')
    set.add('c')
    // Refresh 'a' to most-recently-used position
    set.add('a')
    // Now add 'd' — should evict 'b' (oldest), not 'a'
    set.add('d')
    expect(set.has('a')).toBe(true)
    expect(set.has('b')).toBe(false)
    expect(set.has('d')).toBe(true)
  })

  it('LruSet(1000) holds 1000 items without eviction; adding item 1001 evicts item 1', () => {
    const set = new LruSet(1000)
    for (let i = 1; i <= 1000; i++) {
      set.add(`item-${i}`)
    }
    // All 1000 items present
    expect(set.has('item-1')).toBe(true)
    expect(set.has('item-1000')).toBe(true)
    // Adding item 1001 evicts item-1 (oldest)
    set.add('item-1001')
    expect(set.has('item-1')).toBe(false)
    expect(set.has('item-1001')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// GossipEngine tests
// ---------------------------------------------------------------------------

describe('GossipEngine', () => {
  let emitMetric: ReturnType<typeof vi.fn>

  beforeEach(() => {
    _resetForTest()
    emitMetric = vi.fn()
  })

  it('attachChannel stores onmessage handler on the DataChannel', () => {
    const connections = makeConnections([])
    const engine = new GossipEngine(connections, emitMetric)
    const dc = makeMockDC()
    engine.attachChannel('peer-1', dc)
    expect(dc.onmessage).not.toBeNull()
    expect(typeof dc.onmessage).toBe('function')
  })

  it('onmessage with fresh msgId emits gossip-propagation metric once and adds to seen-set', () => {
    const connections = makeConnections([])
    const engine = new GossipEngine(connections, emitMetric)
    const msg = makeMsg({ seq: 1 })

    engine.onmessage(msg, 'peer-a')

    expect(emitMetric).toHaveBeenCalledTimes(1)
    const emitted = emitMetric.mock.calls[0][0]
    expect(emitted.type).toBe('gossip-propagation')
    expect(emitted.key).toBe(msg.key)
    expect(emitted.msgId).toBe(msg.msgId)
  })

  it('onmessage called twice with same msgId: emitMetric called exactly once (duplicate drop)', () => {
    const connections = makeConnections([])
    const engine = new GossipEngine(connections, emitMetric)
    const msg = makeMsg({ seq: 2 })

    engine.onmessage(msg, 'peer-a')
    engine.onmessage(msg, 'peer-b')

    expect(emitMetric).toHaveBeenCalledTimes(1)
  })

  it('uses a server outbox event ID as the gossip deduplication identity', () => {
    const connections = makeConnections([])
    const engine = new GossipEngine(connections, emitMetric)
    const eventId = crypto.randomUUID()

    engine.sendInvalidation('/api/products/1', 7, 'server', eventId)

    expect(emitMetric).toHaveBeenCalledWith(expect.objectContaining({ msgId: eventId }))
  })

  it('onmessage drops message with seq <= locally cached seq (GOSP-04)', () => {
    const connections = makeConnections([])
    const engine = new GossipEngine(connections, emitMetric)

    // First message with seq=5 sets the bar
    engine.onmessage(makeMsg({ seq: 5 }), 'peer-a')
    expect(emitMetric).toHaveBeenCalledTimes(1)

    // Same key, same seq (5) — should be dropped (seq <= cached)
    engine.onmessage(makeMsg({ seq: 5 }), 'peer-b')
    expect(emitMetric).toHaveBeenCalledTimes(1)

    // Same key, lower seq (3) — should also be dropped
    engine.onmessage(makeMsg({ seq: 3 }), 'peer-c')
    expect(emitMetric).toHaveBeenCalledTimes(1)
  })

  it('onmessage with msg.ttl=1 calls forward; forwarded message has ttl=0', () => {
    const dc = makeMockDC('open')
    const connections = makeConnections([{ peerId: 'peer-b', state: 'connected' }])
    // Override the dc so we can spy on it
    connections.get('peer-b')!.gossip = dc

    const engine = new GossipEngine(connections, emitMetric)
    const msg = makeMsg({ ttl: 1, seq: 1 })

    engine.onmessage(msg, 'origin-peer')

    expect(dc.send).toHaveBeenCalledTimes(1)
    const forwarded = JSON.parse((dc.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string) as GossipMessage
    expect(forwarded.ttl).toBe(0)
  })

  it('onmessage with msg.ttl=0 does not call forward', () => {
    const dc = makeMockDC('open')
    const connections = makeConnections([{ peerId: 'peer-b', state: 'connected' }])
    connections.get('peer-b')!.gossip = dc

    const engine = new GossipEngine(connections, emitMetric)
    const msg = makeMsg({ ttl: 0, seq: 1 })

    engine.onmessage(msg, 'origin-peer')

    expect(dc.send).not.toHaveBeenCalled()
  })

  it('forward with no open channels does not throw', () => {
    const connections = makeConnections([])
    const engine = new GossipEngine(connections, emitMetric)
    const msg = makeMsg({ ttl: 2, seq: 1 })

    expect(() => engine.forward(msg, 'some-peer')).not.toThrow()
  })

  it('swNotify is called after seen-set and seq checks pass, before forwarding', () => {
    const swNotify = vi.fn()
    const connections = makeConnections([])
    const engine = new GossipEngine(connections, emitMetric, swNotify)
    const msg = makeMsg({ seq: 1 })

    engine.onmessage(msg, 'peer-a')

    expect(swNotify).toHaveBeenCalledTimes(1)
    expect(swNotify).toHaveBeenCalledWith({ key: msg.key, seq: msg.seq })
  })

  it('swNotify is NOT called for a duplicate msgId (seen-set drops before notify)', () => {
    const swNotify = vi.fn()
    const connections = makeConnections([])
    const engine = new GossipEngine(connections, emitMetric, swNotify)
    const msg = makeMsg({ seq: 1 })

    engine.onmessage(msg, 'peer-a')
    engine.onmessage(msg, 'peer-b')  // duplicate

    expect(swNotify).toHaveBeenCalledTimes(1)
  })

  it('swNotify is NOT called when seq guard rejects a stale message', () => {
    const swNotify = vi.fn()
    const connections = makeConnections([])
    const engine = new GossipEngine(connections, emitMetric, swNotify)

    engine.onmessage(makeMsg({ seq: 10 }), 'peer-a')
    // stale seq — fresh msgId but lower seq for same key
    engine.onmessage(makeMsg({ seq: 5, key: '/api/products/1' }), 'peer-b')

    expect(swNotify).toHaveBeenCalledTimes(1)
  })

  it('invalid message (missing msgId) is silently dropped', () => {
    const connections = makeConnections([])
    const engine = new GossipEngine(connections, emitMetric)

    // Cast to bypass TS check to test runtime validation
    engine.onmessage({ ...makeMsg(), msgId: '' } as GossipMessage, 'peer-a')

    expect(emitMetric).not.toHaveBeenCalled()
  })
})
