import { describe, expect, it } from 'vitest'
import {
  formatMeshTimeoutError,
  safeResponseUrl,
  type MeshTimeoutSnapshot,
} from '../../scripts/verify-deployed-p2p-diagnostics.js'

describe('verify deployed P2P timeout diagnostics', () => {
  it('redacts token-like query parameters from valid and malformed URLs', () => {
    expect(safeResponseUrl('https://example.test/poll?roomId=room-1&nodexBetaToken=secret-value&keyId=private-key'))
      .toBe('https://example.test/poll?roomId=room-1&nodexBetaToken=%5Bredacted%5D&keyId=%5Bredacted%5D')
    expect(safeResponseUrl('/poll?token=secret-value&roomId=room-1'))
      .toBe('/poll?token=[redacted]&roomId=room-1')
    expect(safeResponseUrl('[signal] Authorization: Bearer bearer-secret token=query-secret'))
      .toBe('[signal] Authorization: Bearer [redacted] token=[redacted]')
  })

  it('formats a mode-aware timeout snapshot without leaking failed-response tokens', () => {
    const snapshot: MeshTimeoutSnapshot = {
      joinMode: 'concurrent',
      roomId: 'room-1',
      failureReason: 'mesh connection timeout; counts=0,0',
      nodes: [
        {
          label: 'nodeA',
          connectedPeerCount: 0,
          connectionStates: [{ peerId: 'peer-b', state: 'connecting' }],
          runtimeConfigProof: {
            apiOrigin: 'https://api.example.test',
            signalingUrl: 'https://api.example.test/api/signal',
            hasToken: true,
            tokenLength: 24,
            urlHasToken: true,
          },
          poll: { status: 200, messageCount: 0 },
          failedResponses: [
            { status: 401, url: 'https://api.example.test/poll?authorization=secret-value&roomId=room-1' },
          ],
        },
      ],
    }

    const error = formatMeshTimeoutError(snapshot)

    expect(error).toContain('mesh connection timeout in concurrent mode for room room-1')
    expect(error).toContain('"failureReason": "mesh connection timeout; counts=0,0"')
    expect(error).toContain('"state": "connecting"')
    expect(error).toContain('"status": 200')
    expect(error).toContain('authorization=%5Bredacted%5D')
    expect(error).not.toContain('secret-value')
  })

  it('redacts token-like values from top-level timeout context', () => {
    const error = formatMeshTimeoutError({
      joinMode: 'sequential',
      roomId: 'room-1?token=room-secret',
      failureReason: 'poll failed authorization=reason-secret',
      nodes: [],
    })

    expect(error).toContain('room-1?token=[redacted]')
    expect(error).toContain('authorization=[redacted]')
    expect(error).not.toContain('room-secret')
    expect(error).not.toContain('reason-secret')
  })
})
