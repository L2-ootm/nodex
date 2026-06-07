export type BetaRole = 'admin' | 'tester'
export type BetaResult = 'pass' | 'partial' | 'fail' | 'not_measured'

export interface BetaInvite {
  label?: string
  assignedName?: string
  assignedEmail?: string
  welcomeNote?: string
  maxSessions?: number
}

export interface StoredAuth {
  token: string
  role: BetaRole
  tokenPreview: string
  invite?: BetaInvite | null
}

export interface TesterProfile {
  name: string
  email: string
  city: string
  country: string
  networkLabel: string
  consentToCredit: boolean
}

export interface BetaSession {
  participantId: string
  sessionToken: string
  roomId: string
  testUrl: string
  ledgerNotice?: string
}

export interface EvidencePayload {
  participantId: string
  roomId: string
  topologyLabel: string
  result: BetaResult
  notes?: string
  telemetry: unknown[]
  storagePressure?: unknown
  runtimeConfig?: unknown
  lifecycleSignals?: unknown[]
  deviceHints?: unknown
}

export interface BetaLogEvent {
  time: string
  level: 'info' | 'warn' | 'error'
  message: string
  details?: unknown
}

export interface PresencePeer {
  name: string
  role: BetaRole
  mode: string
  lastSeen: string
  participantId?: string
  roomId?: string
}

export interface BetaRoom {
  runId: string
  roomId: string
  title?: string
  scenario: string
  dataType: string
  nodeCount: number
  status?: string
  createdAt?: string
}

export interface AdminToken {
  tokenId: string
  tokenPreview: string
  token?: string
  role: BetaRole
  label: string
  createdAt: string
  active: boolean
  assignedName?: string
  assignedEmail?: string
  revokedAt?: string | null
  expiresAt?: string | null
  useCount?: number
  maxSessions?: number
}

export interface BetaRun {
  runId: string
  roomId: string
  scenario: string
  dataType: string
  nodeCount: number
  status?: string
  title?: string
  testUrl?: string
  createdAt?: string
  simulation?: BetaSimulation
}

export interface BetaSimulation {
  simulationId: string
  runId: string
  roomId: string
  scenario: string
  dataType: string
  nodeCount: number
  requestCount: number
  metrics: {
    totalRequests: number
    swCache: number
    peerFetch: number
    serverFallback: number
    hitRatePct: number
    p50LatencyMs: number
    p95LatencyMs: number
    invalidationReachPct: number
    estimatedOriginReadsAvoided: number
  }
  events: Array<{
    key: string
    nodeId: string
    source: string
    latencyMs: number
  }>
}

export interface AuditEvent {
  eventId: string
  eventType: string
  severity: 'info' | 'warn' | 'error'
  actorRole?: BetaRole
  targetType?: string
  targetId?: string
  createdAt: string
}

export interface BetaLedger {
  generatedAt: string
  notice: string
  participants: Array<{
    participantId: string
    roomId: string
    name: string
    email?: string
    city?: string
    country?: string
    consentToCredit: boolean
    evidenceCount: number
    latestEvidenceAt: string | null
  }>
  evidence: Array<{
    evidenceId: string
    participantId: string
    roomId: string
    result: BetaResult
    createdAt: string
  }>
}
