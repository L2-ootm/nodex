import { describe, expect, it } from 'vitest'
import {
  POLICY_SCHEMA_VERSION,
  validatePolicySnapshot,
  type PolicySnapshot,
} from './policy.js'

function makeSnapshot(overrides: Partial<PolicySnapshot> = {}): PolicySnapshot {
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    policyId: 'central-brain-shadow',
    policyVersion: '2026-05-27.1',
    policyMode: 'advisory',
    issuedAt: 1000,
    expiresAt: 2000,
    signature: 'test-signature',
    defaultDecision: {
      ttlTier: 'stable',
      p2pEligibility: 'allow',
      disseminationMode: 'push',
      fanout: 3,
      peerScoringWeights: {
        rtt: 0.4,
        candidateType: 0.2,
        cacheHitRate: 0.4,
      },
    },
    rules: [
      {
        id: 'hot-products',
        match: { pattern: '/api/products/*' },
        decision: {
          ttlTier: 'volatile',
          disseminationMode: 'adaptive-fanout',
          fanout: 4,
        },
      },
    ],
    ...overrides,
  }
}

describe('validatePolicySnapshot', () => {
  it('accepts a signed, fresh advisory policy snapshot', () => {
    const result = validatePolicySnapshot(makeSnapshot(), 1500)

    expect(result.usable).toBe(true)
    expect(result.snapshot?.policyMode).toBe('advisory')
  })

  it('accepts authoritative mode for research comparison', () => {
    const result = validatePolicySnapshot(makeSnapshot({ policyMode: 'authoritative' }), 1500)

    expect(result.usable).toBe(true)
    expect(result.snapshot?.policyMode).toBe('authoritative')
  })

  it('rejects stale snapshots so callers can use deterministic fallback', () => {
    const result = validatePolicySnapshot(makeSnapshot({ expiresAt: 1400 }), 1500)

    expect(result).toEqual({ usable: false, fallbackReason: 'stale' })
  })

  it('rejects unsigned snapshots', () => {
    const result = validatePolicySnapshot(makeSnapshot({ signature: '' }), 1500)

    expect(result).toEqual({ usable: false, fallbackReason: 'unsigned' })
  })

  it('rejects unsafe fanout values', () => {
    const result = validatePolicySnapshot(makeSnapshot({
      rules: [
        {
          id: 'unsafe-fanout',
          match: { pattern: '/api/products/*' },
          decision: { fanout: 99 },
        },
      ],
    }), 1500)

    expect(result).toEqual({ usable: false, fallbackReason: 'unsafe' })
  })
})
