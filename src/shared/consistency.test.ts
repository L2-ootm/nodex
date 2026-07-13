import { describe, expect, it } from 'vitest'
import {
  admitAuthoritativeVersion,
  admitAuthoritativeMetadata,
  admitCandidate,
  observeVersion,
  type CandidatePayloadMeta,
  type ConsistencyPolicy,
} from './consistency.js'

const now = 1_000_000

const baseCandidate: CandidatePayloadMeta = {
  key: '/api/products/42',
  version: 10,
  updatedAt: now - 100,
  class: 'fresh-dynamic',
  hash: 'sha256:test',
}

const freshPolicy: ConsistencyPolicy = {
  class: 'fresh-dynamic',
  peerReads: true,
  maxStaleVersions: 2,
  maxStaleMs: 500,
  requireHash: true,
}

describe('admitCandidate', () => {
  it('admits a candidate inside session, version, time, class, and hash bounds', () => {
    expect(admitCandidate({
      candidate: baseCandidate,
      policy: freshPolicy,
      sessionObservedVersion: 9,
      latestKnownVersion: 11,
      now,
      verifyHash: () => true,
    })).toEqual({ admitted: true })
  })

  it('fails closed when policy is missing', () => {
    expect(admitCandidate({
      candidate: baseCandidate,
      policy: null,
      sessionObservedVersion: 0,
      latestKnownVersion: 10,
      now,
    })).toEqual({ admitted: false, reason: 'missing-policy' })
  })

  it('rejects candidates below the session observed-version barrier', () => {
    expect(admitCandidate({
      candidate: { ...baseCandidate, version: 7 },
      policy: freshPolicy,
      sessionObservedVersion: 8,
      latestKnownVersion: 10,
      now,
      verifyHash: () => true,
    })).toEqual({ admitted: false, reason: 'below-session-observed' })
  })

  it('rejects candidates beyond version staleness budget', () => {
    expect(admitCandidate({
      candidate: { ...baseCandidate, version: 7 },
      policy: freshPolicy,
      sessionObservedVersion: 0,
      latestKnownVersion: 10,
      now,
      verifyHash: () => true,
    })).toEqual({ admitted: false, reason: 'beyond-version-staleness' })
  })

  it('rejects candidates beyond time staleness budget', () => {
    expect(admitCandidate({
      candidate: { ...baseCandidate, updatedAt: now - 501 },
      policy: freshPolicy,
      sessionObservedVersion: 0,
      latestKnownVersion: 10,
      now,
      verifyHash: () => true,
    })).toEqual({ admitted: false, reason: 'beyond-time-staleness' })
  })

  it('rejects forbidden and critical classes from peer reads', () => {
    expect(admitCandidate({
      candidate: { ...baseCandidate, class: 'forbidden' },
      policy: { ...freshPolicy, class: 'forbidden', peerReads: false },
      sessionObservedVersion: 0,
      latestKnownVersion: 10,
      now,
      verifyHash: () => true,
    })).toEqual({ admitted: false, reason: 'class-forbidden' })

    expect(admitCandidate({
      candidate: { ...baseCandidate, class: 'critical' },
      policy: { ...freshPolicy, class: 'critical', peerReads: false },
      sessionObservedVersion: 0,
      latestKnownVersion: 10,
      now,
      verifyHash: () => true,
    })).toEqual({ admitted: false, reason: 'class-forbidden' })
  })

  it('rejects invalid or missing hash when hash verification is required', () => {
    expect(admitCandidate({
      candidate: baseCandidate,
      policy: freshPolicy,
      sessionObservedVersion: 0,
      latestKnownVersion: 10,
      now,
      verifyHash: () => false,
    })).toEqual({ admitted: false, reason: 'hash-invalid' })
  })
})

describe('observeVersion', () => {
  it('keeps observed version monotonic', () => {
    expect(observeVersion(10, 8)).toBe(10)
    expect(observeVersion(10, 12)).toBe(12)
  })

  it('returns max of previous and returned (previous higher)', () => {
    expect(observeVersion(5, 3)).toBe(5)
  })

  it('returns max of previous and returned (returned higher)', () => {
    expect(observeVersion(3, 5)).toBe(5)
  })

  it('throws on negative previousObserved', () => {
    expect(() => observeVersion(-1, 5)).toThrow('observed versions must be finite non-negative numbers')
  })

  it('throws on NaN input', () => {
    expect(() => observeVersion(NaN, 5)).toThrow('observed versions must be finite non-negative numbers')
  })
})

describe('admitCandidate — null/invalid inputs (IMPL-02)', () => {
  it('rejects null candidate', () => {
    expect(admitCandidate({
      candidate: null,
      policy: freshPolicy,
      sessionObservedVersion: 0,
      latestKnownVersion: 10,
      now,
    })).toEqual({ admitted: false, reason: 'invalid-candidate' })
  })

  it('rejects undefined candidate', () => {
    expect(admitCandidate({
      candidate: undefined,
      policy: freshPolicy,
      sessionObservedVersion: 0,
      latestKnownVersion: 10,
      now,
    })).toEqual({ admitted: false, reason: 'invalid-candidate' })
  })
})

describe('admitAuthoritativeVersion', () => {
  it('accepts an authoritative version at or above the session barrier', () => {
    expect(admitAuthoritativeVersion('10', 10)).toEqual({ admitted: true, version: 10 })
    expect(admitAuthoritativeVersion('12', 10)).toEqual({ admitted: true, version: 12 })
  })

  it('rejects a lagging origin or intermediary response', () => {
    expect(admitAuthoritativeVersion('9', 10)).toEqual({
      admitted: false,
      reason: 'below-session-observed',
    })
  })

  it('fails closed when version metadata is missing or malformed', () => {
    expect(admitAuthoritativeVersion(null, 0)).toEqual({ admitted: false, reason: 'missing-version' })
    expect(admitAuthoritativeVersion('', 0)).toEqual({ admitted: false, reason: 'missing-version' })
    expect(admitAuthoritativeVersion('1.5', 0)).toEqual({ admitted: false, reason: 'invalid-version' })
    expect(admitAuthoritativeVersion('not-a-version', 0)).toEqual({ admitted: false, reason: 'invalid-version' })
  })
})

describe('admitAuthoritativeMetadata', () => {
  it('requires a valid server timestamp alongside a non-regressing version', () => {
    expect(admitAuthoritativeMetadata('10', '1000000', 9)).toEqual({ admitted: true, version: 10, validatedAt: 1000000 })
    expect(admitAuthoritativeMetadata('10', null, 9)).toEqual({ admitted: false, reason: 'missing-validated-at' })
    expect(admitAuthoritativeMetadata('10', 'not-a-time', 9)).toEqual({ admitted: false, reason: 'invalid-validated-at' })
    expect(admitAuthoritativeMetadata('8', '1000000', 9)).toEqual({ admitted: false, reason: 'below-session-observed' })
  })
})
