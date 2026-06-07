// src/shared/policy.ts
// Central-brain policy contract for post-beta research.
// This module is intentionally inert: it defines and validates future policy
// snapshots, but it is not wired into the Service Worker or P2P hot path.

export const POLICY_SCHEMA_VERSION = 1
export const POLICY_MIN_FANOUT = 1
export const POLICY_MAX_FANOUT = 10

export const POLICY_MODES = ['advisory', 'authoritative'] as const
export const TTL_TIERS = ['stable', 'volatile', 'ephemeral'] as const
export const P2P_ELIGIBILITY = ['allow', 'deny', 'default'] as const
export const DISSEMINATION_MODES = [
  'default',
  'push',
  'pull',
  'push-pull',
  'adaptive-fanout',
  'anti-entropy',
  'swim-membership',
  'hyparview-partial-view',
  'plumtree-eager-lazy',
] as const
export const PEER_SCORING_WEIGHT_KEYS = [
  'rtt',
  'candidateType',
  'cacheHitRate',
  'churn',
  'storagePressure',
  'geography',
] as const

export type PolicyMode = typeof POLICY_MODES[number]
export type TtlTier = typeof TTL_TIERS[number]
export type P2PEligibility = typeof P2P_ELIGIBILITY[number]
export type DisseminationMode = typeof DISSEMINATION_MODES[number]
export type PeerScoringWeightKey = typeof PEER_SCORING_WEIGHT_KEYS[number]
export type PeerScoringWeights = Partial<Record<PeerScoringWeightKey, number>>

export type PolicyFallbackReason =
  | 'missing'
  | 'malformed'
  | 'unsupported-version'
  | 'stale'
  | 'unsigned'
  | 'unsafe'

export interface PolicyDecision {
  ttlTier?: TtlTier
  p2pEligibility?: P2PEligibility
  disseminationMode?: DisseminationMode
  fanout?: number
  peerScoringWeights?: PeerScoringWeights
}

export interface PolicyRule {
  id: string
  match: {
    key?: string
    pattern?: string
  }
  decision: PolicyDecision
  priority?: number
}

export interface PolicySnapshot {
  schemaVersion: typeof POLICY_SCHEMA_VERSION
  policyId: string
  policyVersion: string
  policyMode: PolicyMode
  issuedAt: number
  expiresAt: number
  signature: string
  defaultDecision: PolicyDecision
  rules: PolicyRule[]
}

export interface PolicySnapshotValidation {
  usable: boolean
  fallbackReason?: PolicyFallbackReason
  snapshot?: PolicySnapshot
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isAllowed(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value)
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isSafeFanout(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= POLICY_MIN_FANOUT &&
    value <= POLICY_MAX_FANOUT
  )
}

function isValidWeights(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value)) return false

  for (const [key, weight] of Object.entries(value)) {
    if (!isAllowed(key, PEER_SCORING_WEIGHT_KEYS)) return false
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1) {
      return false
    }
  }

  return true
}

function isValidDecision(value: unknown): boolean {
  if (!isRecord(value)) return false

  if (value['ttlTier'] !== undefined && !isAllowed(value['ttlTier'], TTL_TIERS)) return false
  if (value['p2pEligibility'] !== undefined && !isAllowed(value['p2pEligibility'], P2P_ELIGIBILITY)) return false
  if (value['disseminationMode'] !== undefined && !isAllowed(value['disseminationMode'], DISSEMINATION_MODES)) return false
  if (value['fanout'] !== undefined && !isSafeFanout(value['fanout'])) return false
  if (!isValidWeights(value['peerScoringWeights'])) return false

  return true
}

function isValidRule(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value['id'])) return false
  if (!isRecord(value['match'])) return false

  const key = value['match']['key']
  const pattern = value['match']['pattern']
  if (!isNonEmptyString(key) && !isNonEmptyString(pattern)) return false

  if (!isValidDecision(value['decision'])) return false
  if (value['priority'] !== undefined && (typeof value['priority'] !== 'number' || !Number.isFinite(value['priority']))) {
    return false
  }

  return true
}

export function validatePolicySnapshot(
  value: unknown,
  now: number = Date.now()
): PolicySnapshotValidation {
  if (value === undefined || value === null) {
    return { usable: false, fallbackReason: 'missing' }
  }

  if (!isRecord(value)) {
    return { usable: false, fallbackReason: 'malformed' }
  }

  if (value['schemaVersion'] !== POLICY_SCHEMA_VERSION) {
    return { usable: false, fallbackReason: 'unsupported-version' }
  }

  if (
    !isNonEmptyString(value['policyId']) ||
    !isNonEmptyString(value['policyVersion']) ||
    !isAllowed(value['policyMode'], POLICY_MODES) ||
    !isFiniteTimestamp(value['issuedAt']) ||
    !isFiniteTimestamp(value['expiresAt']) ||
    !isValidDecision(value['defaultDecision']) ||
    !Array.isArray(value['rules'])
  ) {
    return { usable: false, fallbackReason: 'malformed' }
  }

  if (value['expiresAt'] <= now) {
    return { usable: false, fallbackReason: 'stale' }
  }

  if (!isNonEmptyString(value['signature'])) {
    return { usable: false, fallbackReason: 'unsigned' }
  }

  if (!value['rules'].every(isValidRule)) {
    return { usable: false, fallbackReason: 'unsafe' }
  }

  return { usable: true, snapshot: value as unknown as PolicySnapshot }
}
