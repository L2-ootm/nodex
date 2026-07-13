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

export const DEFAULT_MAX_FUTURE_CLOCK_SKEW_MS = 30_000

export type AdmissionRejectReason =
  | 'missing-policy'
  | 'class-forbidden'
  | 'below-session-observed'
  | 'beyond-version-staleness'
  | 'beyond-time-staleness'
  | 'timestamp-in-future'
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
  maxFutureClockSkewMs?: number
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

export type AuthoritativeVersionRejectReason =
  | 'missing-version'
  | 'invalid-version'
  | 'below-session-observed'

export type AuthoritativeVersionDecision =
  | { admitted: true; version: number }
  | { admitted: false; reason: AuthoritativeVersionRejectReason }

export type AuthoritativeMetadataDecision =
  | { admitted: true; version: number; validatedAt: number }
  | { admitted: false; reason: AuthoritativeVersionRejectReason | 'missing-validated-at' | 'invalid-validated-at' | 'validated-at-in-future' }

export interface AuthoritativeClockOptions {
  now?: number
  maxFutureClockSkewMs?: number
}

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

  const maxFutureClockSkewMs = policy.maxFutureClockSkewMs ?? DEFAULT_MAX_FUTURE_CLOCK_SKEW_MS
  if (
    !isFiniteNonNegative(maxFutureClockSkewMs) ||
    candidate.updatedAt > input.now + maxFutureClockSkewMs
  ) {
    return { admitted: false, reason: 'timestamp-in-future' }
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

/**
 * Validate version metadata from the authoritative read path.
 *
 * The origin is authoritative for ordering, but an intermediary cache or lagging
 * replica can still return an older response. A session that has already observed
 * a newer version must reject that regression rather than silently serving it.
 */
export function admitAuthoritativeVersion(
  rawVersion: string | null,
  sessionObservedVersion: number
): AuthoritativeVersionDecision {
  if (rawVersion === null || rawVersion.trim() === '') {
    return { admitted: false, reason: 'missing-version' }
  }
  if (!isFiniteNonNegative(sessionObservedVersion)) {
    return { admitted: false, reason: 'invalid-version' }
  }

  const version = Number(rawVersion)
  if (!Number.isSafeInteger(version) || version < 1) {
    return { admitted: false, reason: 'invalid-version' }
  }
  if (version < sessionObservedVersion) {
    return { admitted: false, reason: 'below-session-observed' }
  }

  return { admitted: true, version }
}

export function admitAuthoritativeMetadata(
  rawVersion: string | null,
  rawValidatedAt: string | null,
  sessionObservedVersion: number,
  clock: AuthoritativeClockOptions = {}
): AuthoritativeMetadataDecision {
  const version = admitAuthoritativeVersion(rawVersion, sessionObservedVersion)
  if (!version.admitted) return version
  if (rawValidatedAt === null || rawValidatedAt.trim() === '') {
    return { admitted: false, reason: 'missing-validated-at' }
  }
  const validatedAt = Number(rawValidatedAt)
  if (!Number.isSafeInteger(validatedAt) || validatedAt <= 0) {
    return { admitted: false, reason: 'invalid-validated-at' }
  }
  const now = clock.now ?? Date.now()
  const maxFutureClockSkewMs = clock.maxFutureClockSkewMs ?? DEFAULT_MAX_FUTURE_CLOCK_SKEW_MS
  if (
    !isFiniteNonNegative(now) ||
    !isFiniteNonNegative(maxFutureClockSkewMs) ||
    validatedAt > now + maxFutureClockSkewMs
  ) {
    return { admitted: false, reason: 'validated-at-in-future' }
  }
  return { admitted: true, version: version.version, validatedAt }
}
