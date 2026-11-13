import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'
import type { PeerFetchResponse } from '../shared/types.js'
import {
  _resetForTest,
  buildStoragePressureSample,
  candidateTypeFromPair,
  connections,
  extractPeerTelemetryFromStats,
  pendingRequests,
  MAX_PENDING_PEER_REQUESTS,
  MAX_PEER_BUFFERED_BYTES,
  sendCacheFetchRequest,
  peerManager,
  selectConnectedPeer,
  isPolitePeer,
} from './p2p-manager.js'

describe('p2p-manager', () => {
  it('concurrent HTTP discovery assigns opposite negotiation roles to a peer pair', () => {
    expect(isPolitePeer('node-a', 'node-b')).toBe(false)
    expect(isPolitePeer('node-b', 'node-a')).toBe(true)
  })
  beforeEach(() => {
    _resetForTest()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('F17 request and backpressure caps', () => {
    const fakeConn = (readyState: string, bufferedAmount: number) => {
      const send = vi.fn()
      return { send, conn: { peerId: 'p', cacheFetch: { readyState, bufferedAmount, send } } as never }
    }
    const fakePort = () => ({ postMessage: vi.fn(), close: vi.fn() })

    it('rejects without sending when pending requests are at the cap', () => {
      for (let i = 0; i < MAX_PENDING_PEER_REQUESTS; i++) {
        pendingRequests.set(`r${i}`, { peerId: 'p', resolver: () => {} })
      }
      const { send, conn } = fakeConn('open', 0)
      const port = fakePort()
      sendCacheFetchRequest(conn, 'k', port as never)
      expect(send).not.toHaveBeenCalled()
      expect(port.postMessage).toHaveBeenCalledWith({ type: 'P2P_FETCH_RESPONSE', found: false })
      expect(pendingRequests.size).toBe(MAX_PENDING_PEER_REQUESTS)
    })

    it('rejects when the data channel buffer exceeds the limit or is not open', () => {
      for (const [state, buffered] of [['open', MAX_PEER_BUFFERED_BYTES + 1], ['closing', 0]] as const) {
        const { send, conn } = fakeConn(state, buffered)
        const port = fakePort()
        sendCacheFetchRequest(conn, 'k', port as never)
        expect(send).not.toHaveBeenCalled()
        expect(port.postMessage).toHaveBeenCalledWith({ type: 'P2P_FETCH_RESPONSE', found: false })
      }
      expect(pendingRequests.size).toBe(0)
    })

    it('sends and registers a pending request when under every limit', () => {
      vi.useFakeTimers()
      const { send, conn } = fakeConn('open', MAX_PEER_BUFFERED_BYTES)
      sendCacheFetchRequest(conn, 'k', fakePort() as never)
      expect(send).toHaveBeenCalledTimes(1)
      expect(pendingRequests.size).toBe(1)
      vi.useRealTimers()
    })
  })

  it('reqId correlation routes response to correct resolver', () => {
    const called: string[] = []

    pendingRequests.set('req-A', { resolver: (_r: PeerFetchResponse) => { called.push('A') }, peerId: 'peer-1' })
    pendingRequests.set('req-B', { resolver: (_r: PeerFetchResponse) => { called.push('B') }, peerId: 'peer-2' })

    // Simulate incoming CACHE_FETCH_RESPONSE matching req-A
    const data: PeerFetchResponse = {
      type: 'CACHE_FETCH_RESPONSE',
      reqId: 'req-A',
      found: true,
      payload: '{"data":1}',
    }

    const entry = pendingRequests.get(data.reqId)
    if (entry) {
      entry.resolver(data)
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

  it('classifies selected candidate type conservatively', () => {
    expect(candidateTypeFromPair('host', 'host')).toBe('host')
    expect(candidateTypeFromPair('host', 'srflx')).toBe('srflx')
    expect(candidateTypeFromPair('prflx', 'host')).toBe('srflx')
    expect(candidateTypeFromPair('relay', 'host')).toBe('relay')
    expect(candidateTypeFromPair(undefined, 'host')).toBe('unknown')
    expect(candidateTypeFromPair('bogus', 'host')).toBe('unknown')
  })

  it('extracts edge telemetry from a selected WebRTC candidate pair stats report', () => {
    const report = new Map<string, Record<string, unknown>>([
      ['transport-1', { id: 'transport-1', type: 'transport', selectedCandidatePairId: 'pair-1' }],
      ['pair-1', {
        id: 'pair-1',
        type: 'candidate-pair',
        state: 'succeeded',
        localCandidateId: 'local-1',
        remoteCandidateId: 'remote-1',
        currentRoundTripTime: 0.012,
        bytesSent: 1024,
        bytesReceived: 2048,
      }],
      ['local-1', { id: 'local-1', type: 'local-candidate', candidateType: 'host' }],
      ['remote-1', { id: 'remote-1', type: 'remote-candidate', candidateType: 'srflx' }],
    ])

    const sample = extractPeerTelemetryFromStats({
      roomId: 'room-a',
      nodeId: 'node-a',
      peerId: 'node-b',
      role: 'local',
      connectionState: 'connected',
      iceConnectionState: 'connected',
      dataChannelState: 'open',
      timestamp: 1234,
      stats: report,
    })

    expect(sample).toMatchObject({
      room_id: 'room-a',
      node_id: 'node-a',
      peer_id: 'node-b',
      selected_candidate_type: 'srflx',
      local_candidate_type: 'host',
      remote_candidate_type: 'srflx',
      current_round_trip_time_ms: 12,
      bytes_sent: 1024,
      bytes_received: 2048,
    })
  })

  it('builds storage pressure samples with a bounded usage ratio', () => {
    expect(buildStoragePressureSample({
      roomId: 'room-a',
      topologyLabel: 'loopback',
      nodeId: 'node-a',
      usage: 25,
      quota: 100,
      timestamp: 1234,
    })).toMatchObject({
      room_id: 'room-a',
      topology_label: 'loopback',
      node_id: 'node-a',
      usage_bytes: 25,
      quota_bytes: 100,
      usage_ratio: 0.25,
    })

    expect(buildStoragePressureSample({
      roomId: 'room-a',
      topologyLabel: 'loopback',
      nodeId: 'node-a',
      usage: 50,
      quota: 0,
      timestamp: 1234,
    }).usage_ratio).toBeNull()
  })

  it('connects to peers discovered by HTTP signaling polls after an empty join list', async () => {
    const intervalCallbacks: Array<() => void> = []
    const localStore = new Map<string, string>()

    class TestMessageChannel {
      port1: { onmessage: ((event: MessageEvent) => void) | null; postMessage: (data: unknown) => void }
      port2: { onmessage: ((event: MessageEvent) => void) | null; postMessage: (data: unknown) => void }

      constructor() {
        this.port1 = {
          onmessage: null,
          postMessage: (data: unknown) => {
            this.port2.onmessage?.({ data } as MessageEvent)
          },
        }
        this.port2 = {
          onmessage: null,
          postMessage: (data: unknown) => {
            this.port1.onmessage?.({ data } as MessageEvent)
          },
        }
      }
    }

    class MockDataChannel extends EventTarget {
      readyState: RTCDataChannelState = 'connecting'
      onmessage: ((this: RTCDataChannel, ev: MessageEvent) => unknown) | null = null
      send = vi.fn()
    }

    class MockRTCPeerConnection extends EventTarget {
      connectionState: RTCPeerConnectionState = 'new'
      iceConnectionState: RTCIceConnectionState = 'new'
      iceGatheringState: RTCIceGatheringState = 'new'
      signalingState: RTCSignalingState = 'stable'
      localDescription: RTCSessionDescriptionInit | null = null
      remoteDescription: RTCSessionDescriptionInit | null = null
      onnegotiationneeded: ((this: RTCPeerConnection, ev: Event) => unknown) | null = null
      onicecandidate: ((this: RTCPeerConnection, ev: RTCPeerConnectionIceEvent) => unknown) | null = null

      createDataChannel(): RTCDataChannel {
        return new MockDataChannel() as unknown as RTCDataChannel
      }

      async setLocalDescription(): Promise<void> {
        this.localDescription = { type: 'offer', sdp: 'mock-offer' }
      }

      async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
        this.remoteDescription = description
      }

      async addIceCandidate(): Promise<void> {}
      async getStats(): Promise<RTCStatsReport> { return new Map() as unknown as RTCStatsReport }
      restartIce(): void {}
      close(): void {}
    }

    vi.stubGlobal('MessageChannel', TestMessageChannel)
    vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection)
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStore.get(key) ?? null,
      setItem: (key: string, value: string) => { localStore.set(key, value) },
      removeItem: (key: string) => { localStore.delete(key) },
    })
    vi.stubGlobal('window', {
      location: {
        search: '?nodexRoom=room-a&nodexSignalingUrl=https%3A%2F%2Fsignal.test%2Fapi%2Fsignal',
      },
      setInterval: vi.fn((callback: () => void) => {
        intervalCallbacks.push(callback)
        return intervalCallbacks.length
      }),
      setTimeout: vi.fn((callback: () => void) => {
        intervalCallbacks.push(callback)
        return intervalCallbacks.length
      }),
      clearInterval: vi.fn(),
      addEventListener: vi.fn(),
    })
    vi.stubGlobal('navigator', {
      serviceWorker: {
        controller: {
          postMessage: (_message: unknown, ports?: Array<{ postMessage: (data: unknown) => void }>) => {
            ports?.[0]?.postMessage({ type: 'NODE_ID', nodeId: 'node-a' })
          },
        },
        addEventListener: vi.fn(),
      },
      storage: { estimate: vi.fn() },
      maxTouchPoints: 0,
      userAgent: 'vitest',
      platform: 'test',
    })

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/join')) {
        return new Response(JSON.stringify({ peers: [], polite: false, after: 0, nodeGrant: 'grant-a' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.startsWith('https://signal.test/api/signal/poll')) {
        return new Response(JSON.stringify({ peers: ['node-b'], polite: true, messages: [] }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    await peerManager.init()
    expect(connections.has('node-b')).toBe(false)

    intervalCallbacks.at(-1)?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(connections.has('node-b')).toBe(true)
    // Exercise the real failure handler deterministically. This checks bounded
    // retries and request cleanup; it does not simulate a WAN ICE recovery.
    const pc = connections.get('node-b')!.pc
    const restart = vi.spyOn(pc, 'restartIce')
    const close = vi.spyOn(pc, 'close')
    const failedReply = vi.fn()
    const unrelatedReply = vi.fn()
    pendingRequests.set('failed-request', { peerId: 'node-b', resolver: failedReply })
    pendingRequests.set('other-request', { peerId: 'other-peer', resolver: unrelatedReply })
    ;(pc as unknown as { connectionState: string }).connectionState = 'failed'
    for (let attempt = 0; attempt < 3; attempt++) pc.dispatchEvent(new Event('connectionstatechange'))
    expect(restart).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledOnce()
    expect(failedReply).toHaveBeenCalledOnce()
    expect(pendingRequests.has('failed-request')).toBe(false)
    expect(unrelatedReply).not.toHaveBeenCalled()
    expect(pendingRequests.has('other-request')).toBe(true)
    expect(connections.has('node-b')).toBe(false)
  })
})
