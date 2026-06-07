// src/shared/consistency.ts
// Pure executable admission contract for Nodex candidate reads.
// Implements the G3/G9 formal model fail-closed rule without browser APIs.

export const NODEX_DATA_CLASSES = [
  'critical',
  'fresh-dynamic',
  'session-owned',
  'mergeable',
  'cold-blob',
  'forbidden',
] as const

export type NodexDataClass = typeof NODEX_DATA_CLASSES[number]

export type AdmissionRejectReason =
  | 'missing-policy'
  | 'class-forbidden'
  | 'below-session-observed'
  | 'beyond-version-staleness'
  | 'beyond-time-staleness'
  | 'hash-invalid'
  | 'invalid-candidate'

export interface CandidatePayloadMeta {
  key: string
  version: number
  updatedAt: number
  class: NodexDataClass
  hash?: string
}

export interface ConsistencyPolicy {
  class: NodexDataClass
  peerReads: boolean
  maxStaleVersions?: number
  maxStaleMs?: number
  requireHash?: boolean
}

export interface AdmissionInput {
  candidate: CandidatePayloadMeta | null | undefined
  policy: ConsistencyPolicy | null | undefined
  sessionObservedVersion: number
  latestKnownVersion: number
  now: number
  verifyHash?: (candidate: CandidatePayloadMeta) => boolean
}

export type AdmissionDecision =
  | { admitted: true }
  | { admitted: false; reason: AdmissionRejectReason }

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

export function admitCandidate(input: AdmissionInput): AdmissionDecision {
  const { candidate, policy } = input

  if (!policy) return { admitted: false, reason: 'missing-policy' }
  if (!candidate) return { admitted: false, reason: 'invalid-candidate' }

  if (
    !isFiniteNonNegative(candidate.version) ||
    !isFiniteNonNegative(candidate.updatedAt) ||
    !isFiniteNonNegative(input.sessionObservedVersion) ||
    !isFiniteNonNegative(input.latestKnownVersion) ||
    !isFiniteNonNegative(input.now)
  ) {
    return { admitted: false, reason: 'invalid-candidate' }
  }

  if (!policy.peerReads || policy.class === 'critical' || policy.class === 'forbidden' || candidate.class === 'forbidden') {
    return { admitted: false, reason: 'class-forbidden' }
  }

  if (candidate.version < input.sessionObservedVersion) {
    return { admitted: false, reason: 'below-session-observed' }
  }

  if (
    policy.maxStaleVersions !== undefined &&
    candidate.version < input.latestKnownVersion - policy.maxStaleVersions
  ) {
    return { admitted: false, reason: 'beyond-version-staleness' }
  }

  if (
    policy.maxStaleMs !== undefined &&
    input.now - candidate.updatedAt > policy.maxStaleMs
  ) {
    return { admitted: false, reason: 'beyond-time-staleness' }
  }

  if (policy.requireHash && (!candidate.hash || input.verifyHash?.(candidate) !== true)) {
    return { admitted: false, reason: 'hash-invalid' }
  }

  return { admitted: true }
}

export function observeVersion(previousObserved: number, returnedVersion: number): number {
  if (!isFiniteNonNegative(previousObserved) || !isFiniteNonNegative(returnedVersion)) {
    throw new Error('observed versions must be finite non-negative numbers')
  }
  return Math.max(previousObserved, returnedVersion)
}
