// src/p2p/evidence-capture.test.ts
import { describe, it, expect } from 'vitest'
import { classifyRun, getCommitHash } from './evidence-capture.js'

describe('classifyRun', () => {
  it('exposes the Vite-injected build commit for deployment evidence', () => {
    expect(getCommitHash()).toBe('test')
  })

  it('not_measured when no connection attempted', () => {
    const result = classifyRun({
      webrtcEdgeFormed: false,
      peerFetchOccurred: false,
      connectionAttempted: false,
      iceCandidateType: 'unknown',
    })
    expect(result.classification).toBe('not_measured')
    expect(result.reason).toMatch(/No WebRTC connection/)
  })

  it('fail when connection attempted but edge did not form', () => {
    const result = classifyRun({
      webrtcEdgeFormed: false,
      peerFetchOccurred: false,
      connectionAttempted: true,
      iceCandidateType: 'unknown',
    })
    expect(result.classification).toBe('fail')
    expect(result.reason).toMatch(/edge did not form/)
  })

  it('partial when edge formed but no peer-fetch', () => {
    const result = classifyRun({
      webrtcEdgeFormed: true,
      peerFetchOccurred: false,
      connectionAttempted: true,
      iceCandidateType: 'host',
    })
    expect(result.classification).toBe('partial')
    expect(result.reason).toMatch(/no peer-fetch/)
  })

  it('pass when edge formed and peer-fetch occurred with known ICE type', () => {
    const result = classifyRun({
      webrtcEdgeFormed: true,
      peerFetchOccurred: true,
      connectionAttempted: true,
      iceCandidateType: 'host',
    })
    expect(result.classification).toBe('pass')
    expect(result.reason).toMatch(/host/)
  })

  it('pass with srflx ICE type', () => {
    const result = classifyRun({
      webrtcEdgeFormed: true,
      peerFetchOccurred: true,
      connectionAttempted: true,
      iceCandidateType: 'srflx',
    })
    expect(result.classification).toBe('pass')
    expect(result.reason).toMatch(/srflx/)
  })

  it('pass with relay ICE type', () => {
    const result = classifyRun({
      webrtcEdgeFormed: true,
      peerFetchOccurred: true,
      connectionAttempted: true,
      iceCandidateType: 'relay',
    })
    expect(result.classification).toBe('pass')
    expect(result.reason).toMatch(/relay/)
  })

  it('partial when peer-fetch occurred but ICE type is unknown', () => {
    const result = classifyRun({
      webrtcEdgeFormed: true,
      peerFetchOccurred: true,
      connectionAttempted: true,
      iceCandidateType: 'unknown',
    })
    expect(result.classification).toBe('partial')
    expect(result.reason).toMatch(/ICE candidate type is unresolved/)
  })
})
