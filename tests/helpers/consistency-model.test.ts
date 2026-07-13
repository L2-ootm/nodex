import { describe, expect, it } from 'vitest'
import {
  admitAuthoritativeVersion,
  admitCandidate,
  observeVersion,
  type ConsistencyPolicy,
} from '../../src/shared/consistency.js'

const policy: ConsistencyPolicy = {
  class: 'fresh-dynamic',
  peerReads: true,
  maxStaleVersions: 2,
  maxStaleMs: 5_000,
}

function deterministicRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

describe('consistency model fault injection', () => {
  it('never admits a version below the session barrier across mixed read paths', () => {
    const random = deterministicRandom(0x4e4f4445)
    let latestServerVersion = 1
    let observedVersion = 0
    let naiveObservedVersion = 0
    let naiveRegressions = 0
    let rejectedFaults = 0

    for (let operation = 0; operation < 10_000; operation += 1) {
      if (random() < 0.18) latestServerVersion += 1

      const lag = Math.floor(random() * 6)
      const candidateVersion = Math.max(1, latestServerVersion - lag)
      const source = Math.floor(random() * 3) as 0 | 1 | 2

      if (candidateVersion < naiveObservedVersion) naiveRegressions += 1
      naiveObservedVersion = candidateVersion

      if (source === 2) {
        const metadataFault = random()
        const rawVersion = metadataFault < 0.04
          ? null
          : metadataFault < 0.08
            ? 'malformed'
            : String(candidateVersion)
        const decision = admitAuthoritativeVersion(rawVersion, observedVersion)
        if (!decision.admitted) {
          rejectedFaults += 1
          continue
        }
        expect(decision.version).toBeGreaterThanOrEqual(observedVersion)
        observedVersion = observeVersion(observedVersion, decision.version)
        continue
      }

      const now = operation * 100
      const hasAgeMetadata = random() >= 0.08
      const decision = admitCandidate({
        candidate: {
          key: '/api/products/model',
          version: candidateVersion,
          updatedAt: hasAgeMetadata ? Math.max(0, now - Math.floor(random() * 8_000)) : Number.NaN,
          class: 'fresh-dynamic',
        },
        policy,
        sessionObservedVersion: observedVersion,
        latestKnownVersion: latestServerVersion,
        now,
      })

      if (!decision.admitted) {
        rejectedFaults += 1
        continue
      }
      expect(candidateVersion).toBeGreaterThanOrEqual(observedVersion)
      observedVersion = observeVersion(observedVersion, candidateVersion)
    }

    expect(naiveRegressions).toBeGreaterThan(0)
    expect(rejectedFaults).toBeGreaterThan(0)
    expect(observedVersion).toBeGreaterThan(0)
  })
})
