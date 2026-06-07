import { describe, it, expect, beforeEach } from 'vitest'
import type { PeerFetchResponse } from '../shared/types.js'
import {
  _resetForTest,
  buildStoragePressureSample,
  candidateTypeFromPair,
  extractPeerTelemetryFromStats,
  pendingRequests,
  selectConnectedPeer,
} from './p2p-manager.js'

describe('p2p-manager', () => {
  beforeEach(() => {
    _resetForTest()
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
})
