// src/server/beta-coordinator.ts
// Beta coordination server for invited external validation runs.
// POC infrastructure only: role-token gated sessions, local JSONL evidence,
// simulated run orchestration, tester log capture, and contributor ledger export.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { get, put } from '@vercel/blob'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { DEFAULT_SIGNALING_URL } from '../shared/config.js'

export type BetaEvidenceResult = 'pass' | 'partial' | 'fail' | 'not_measured'
export type BetaTokenRole = 'admin' | 'tester'

export interface BetaParticipantInput {
  name: string
  email?: string
  city?: string
  country?: string
  networkLabel?: string
  consentToCredit: boolean
  contributionNote?: string
}

export interface BetaParticipantRecord extends BetaParticipantInput {
  schema_version: 1
  participantId: string
  roomId: string
  createdAt: string
  inviteTokenId?: string
  inviteTokenLabel?: string
  inviteTokenHash?: string
}

export interface BetaEvidenceInput {
  participantId: string
  roomId: string
  topologyLabel: string
  result: BetaEvidenceResult
  notes?: string
  telemetry?: unknown[]
  storagePressure?: unknown
  runtimeConfig?: unknown
  lifecycleSignals?: unknown[]
  deviceHints?: unknown
}

export interface BetaEvidenceRecord extends BetaEvidenceInput {
  schema_version: 1
  evidenceId: string
  createdAt: string
}

export interface BetaSessionRecord {
  schema_version: 1
  sessionTokenHash: string
  participantId: string
  roomId: string
  createdAt: string
  expiresAt: string
  revokedAt?: string | null
}

export interface BetaLedgerParticipant extends BetaParticipantRecord {
  evidenceCount: number
  latestEvidenceAt: string | null
}

export interface BetaLedger {
  schema_version: 1
  generatedAt: string
  notice: string
  participants: BetaLedgerParticipant[]
  evidence: BetaEvidenceRecord[]
}

export interface BetaTokenRecord {
  schema_version: 1
  tokenId: string
  tokenHash: string
  tokenPreview: string
  role: BetaTokenRole
  label: string
  assignedName?: string
  assignedEmail?: string
  welcomeNote?: string
  maxSessions: number
  createdAt: string
  createdBy: string
  active: boolean
  expiresAt?: string | null
  revokedAt?: string | null
  revokedBy?: string | null
  lastUsedAt?: string | null
  lastUsedIp?: string | null
  lastUsedUserAgent?: string | null
  useCount?: number
}

export interface BetaRunInput {
  title?: string
  scenario: string
  dataType: string
  nodeCount: number
  notes?: string
}

export interface BetaRunRecord extends BetaRunInput {
  schema_version: 1
  runId: string
  roomId: string
  status: 'ready' | 'running' | 'completed'
  createdAt: string
  createdBy: string
}

export type BetaSimulationSource = 'sw-cache' | 'peer-fetch' | 'server-fallback'

export interface BetaSimulationEvent {
  requestId: string
  key: string
  nodeId: string
  source: BetaSimulationSource
  latencyMs: number
  seq: number
  gossipHop: number
  createdAt: string
}

export interface BetaSimulationMetrics {
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

export interface BetaSimulationRecord {
  schema_version: 1
  simulationId: string
  runId: string
  roomId: string
  scenario: string
  dataType: string
  nodeCount: number
  requestCount: number
  status: 'completed'
  createdAt: string
  createdBy: string
  metrics: BetaSimulationMetrics
  events: BetaSimulationEvent[]
}

export interface BetaLogInput {
  participantId?: string
  roomId?: string
  runId?: string
  level: 'info' | 'warn' | 'error'
  message: string
  details?: unknown
}

export interface BetaLogRecord extends BetaLogInput {
  schema_version: 1
  logId: string
  createdAt: string
  tokenRole: BetaTokenRole
}

export interface BetaTokenMeta {
  assignedName?: string
  assignedEmail?: string
  welcomeNote?: string
}

export interface BetaAuditEventInput {
  eventType: string
  severity?: BetaLogInput['level']
  actorTokenHash?: string
  actorRole?: BetaTokenRole
  targetType?: string
  targetId?: string
  ipAddress?: string
  userAgent?: string
  details?: unknown
}

export interface BetaAuditEventRecord extends BetaAuditEventInput {
  schema_version: 1
  eventId: string
  createdAt: string
  severity: BetaLogInput['level']
}

export interface BetaAuthAttemptInput {
  tokenHash?: string
  tokenPreview?: string
  ipAddress?: string
  userAgent?: string
  success: boolean
  failureReason?: string
}

export interface BetaAuthAttemptRecord extends BetaAuthAttemptInput {
  schema_version: 1
  attemptId: string
  createdAt: string
}

export interface BetaCoordinatorOptions {
  dataDir: string
  inviteTokens: string[]
  adminTokens?: string[]
  tokenMeta?: Record<string, BetaTokenMeta>
  appOrigin?: string
  signalingUrl?: string
  allowedOrigins?: string[]
}

export interface BetaStore {
  createParticipant(input: BetaParticipantInput, invite?: Pick<BetaTokenRecord, 'tokenId' | 'tokenHash' | 'label'>): Promise<BetaParticipantRecord>
  createSession(participant: Pick<BetaParticipantRecord, 'participantId' | 'roomId'>, sessionToken: string): Promise<BetaSessionRecord>
  readSession(sessionToken: string): Promise<BetaSessionRecord | null>
  appendEvidence(input: BetaEvidenceInput): Promise<BetaEvidenceRecord>
  createToken(input: {
    role: BetaTokenRole
    label: string
    createdBy: string
    assignedName?: string
    assignedEmail?: string
    welcomeNote?: string
    maxSessions: number
  }): Promise<BetaTokenRecord & { token: string }>
  readTokens(): Promise<BetaTokenRecord[]>
  readParticipants(): Promise<BetaParticipantRecord[]>
  createRun(input: BetaRunInput, createdBy: string): Promise<BetaRunRecord>
  readRuns(): Promise<BetaRunRecord[]>
  createSimulation(run: BetaRunRecord, createdBy: string, requestCount?: number): Promise<BetaSimulationRecord>
  readSimulations(): Promise<BetaSimulationRecord[]>
  appendLog(input: BetaLogInput, tokenRole: BetaTokenRole): Promise<BetaLogRecord>
  readLogs(): Promise<BetaLogRecord[]>
  revokeToken(tokenId: string, revokedBy: string): Promise<BetaTokenRecord | null>
  recordTokenUse(tokenHash: string, metadata?: { ipAddress?: string; userAgent?: string }): Promise<void>
  appendAuditEvent(input: BetaAuditEventInput): Promise<BetaAuditEventRecord>
  readAuditEvents(limit?: number): Promise<BetaAuditEventRecord[]>
  appendAuthAttempt(input: BetaAuthAttemptInput): Promise<BetaAuthAttemptRecord>
  countRecentFailedAuthAttempts(tokenHash: string, sinceIso: string): Promise<number>
  readLedger(): Promise<BetaLedger>
}

function compactId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function createPlainToken(role: BetaTokenRole): string {
  return `nodex-${role}-${globalThis.crypto.randomUUID().replaceAll('-', '')}`
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function previewToken(token: string): string {
  return token.length <= 12 ? token : `${token.slice(0, 10)}...${token.slice(-4)}`
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function safeEmail(value: unknown): string | undefined {
  const email = nonEmptyString(value)
  if (!email) return undefined
  return email.includes('@') ? email.slice(0, 200) : undefined
}

function uuidOrNull(value: string | undefined): string | null {
  if (!value) return null
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null
}

function sanitizeParticipantInput(value: unknown): BetaParticipantInput | null {
  const input = value as Record<string, unknown>
  const name = nonEmptyString(input['name'])
  if (!name) return null

  return {
    name: name.slice(0, 120),
    email: safeEmail(input['email']),
    city: nonEmptyString(input['city'])?.slice(0, 80),
    country: nonEmptyString(input['country'])?.slice(0, 80),
    networkLabel: nonEmptyString(input['networkLabel'])?.slice(0, 120),
    consentToCredit: input['consentToCredit'] === true,
    contributionNote: nonEmptyString(input['contributionNote'])?.slice(0, 1000),
  }
}

function sanitizeEvidenceInput(value: unknown): BetaEvidenceInput | null {
  const input = value as Record<string, unknown>
  const participantId = nonEmptyString(input['participantId'])
  const roomId = nonEmptyString(input['roomId'])
  const topologyLabel = nonEmptyString(input['topologyLabel'])
  const result = input['result']
  if (
    !participantId ||
    !roomId ||
    !topologyLabel ||
    (result !== 'pass' && result !== 'partial' && result !== 'fail' && result !== 'not_measured')
  ) {
    return null
  }

  return {
    participantId,
    roomId,
    topologyLabel: topologyLabel.slice(0, 120),
    result,
    notes: nonEmptyString(input['notes'])?.slice(0, 2000),
    telemetry: Array.isArray(input['telemetry']) ? input['telemetry'].slice(0, 100) : [],
    storagePressure: input['storagePressure'],
    runtimeConfig: input['runtimeConfig'],
    lifecycleSignals: Array.isArray(input['lifecycleSignals']) ? input['lifecycleSignals'].slice(0, 100) : [],
    deviceHints: input['deviceHints'],
  }
}

function sanitizeRole(value: unknown): BetaTokenRole {
  return value === 'admin' ? 'admin' : 'tester'
}

function sanitizeTokenCreateInput(value: unknown): {
  role: BetaTokenRole
  label: string
  assignedName?: string
  assignedEmail?: string
  welcomeNote?: string
  maxSessions: number
} {
  const input = value as Record<string, unknown>
  const role = sanitizeRole(input['role'])
  const assignedName = nonEmptyString(input['assignedName'])?.slice(0, 120)
  const assignedEmail = safeEmail(input['assignedEmail'])
  const label = (nonEmptyString(input['label']) ?? assignedName ?? 'Beta tester').slice(0, 120)
  const maxSessionsInput = Number(input['maxSessions'])
  const defaultMaxSessions = role === 'tester' ? 1 : 20
  return {
    role,
    label,
    assignedName,
    assignedEmail,
    welcomeNote: nonEmptyString(input['welcomeNote'])?.slice(0, 500),
    maxSessions: Number.isFinite(maxSessionsInput)
      ? Math.max(1, Math.min(20, Math.round(maxSessionsInput)))
      : defaultMaxSessions,
  }
}

function sanitizeRunInput(value: unknown): BetaRunInput | null {
  const input = value as Record<string, unknown>
  const scenario = nonEmptyString(input['scenario'])
  const dataType = nonEmptyString(input['dataType'])
  const nodeCount = Number(input['nodeCount'])
  if (!scenario || !dataType || !Number.isFinite(nodeCount)) return null

  return {
    title: nonEmptyString(input['title'])?.slice(0, 120),
    scenario: scenario.slice(0, 120),
    dataType: dataType.slice(0, 80),
    nodeCount: Math.max(2, Math.min(50, Math.round(nodeCount))),
    notes: nonEmptyString(input['notes'])?.slice(0, 1000),
  }
}

function sanitizeLogInput(value: unknown): BetaLogInput | null {
  const input = value as Record<string, unknown>
  const level = input['level']
  const message = nonEmptyString(input['message'])
  if ((level !== 'info' && level !== 'warn' && level !== 'error') || !message) return null

  return {
    participantId: nonEmptyString(input['participantId'])?.slice(0, 120),
    roomId: nonEmptyString(input['roomId'])?.slice(0, 160),
    runId: nonEmptyString(input['runId'])?.slice(0, 120),
    level,
    message: message.slice(0, 500),
    details: input['details'],
  }
}

async function appendJsonl(filePath: string, record: unknown): Promise<void> {
  if (useBlobStore()) {
    const existing = await readBlobJsonlText(filePath)
    await put(blobKey(filePath), `${existing}${JSON.stringify(record)}\n`, {
      access: 'private',
      allowOverwrite: true,
      contentType: 'application/x-ndjson',
    })
    return
  }
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(record)}\n`, { flag: 'a' })
}

async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  const body = records.map((record) => JSON.stringify(record)).join('\n')
  const text = body.length > 0 ? `${body}\n` : ''
  if (useBlobStore()) {
    await put(blobKey(filePath), text, {
      access: 'private',
      allowOverwrite: true,
      contentType: 'application/x-ndjson',
    })
    return
  }
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, text)
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  if (useBlobStore()) {
    const raw = await readBlobJsonlText(filePath)
    return parseJsonl<T>(raw)
  }
  try {
    const raw = await readFile(filePath, 'utf8')
    return parseJsonl<T>(raw)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    throw err
  }
}

function parseJsonl<T>(raw: string): T[] {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T)
}

function useBlobStore(): boolean {
  return Boolean(process.env['BLOB_READ_WRITE_TOKEN'])
}

function blobKey(filePath: string): string {
  return `nodex-beta/${path.basename(filePath)}`
}

async function readBlobJsonlText(filePath: string): Promise<string> {
  const blob = await get(blobKey(filePath), { access: 'private', useCache: false }).catch((err: unknown) => {
    if ((err as Error).name === 'BlobNotFoundError') return null
    throw err
  })
  if (!blob || blob.statusCode === 304 || !blob.stream) return ''
  return await new Response(blob.stream).text()
}

export function createBetaStore(dataDir: string): BetaStore {
  const participantsPath = path.join(dataDir, 'participants.jsonl')
  const evidencePath = path.join(dataDir, 'evidence.jsonl')
  const tokensPath = path.join(dataDir, 'tokens.jsonl')
  const sessionsPath = path.join(dataDir, 'sessions.jsonl')
  const runsPath = path.join(dataDir, 'runs.jsonl')
  const simulationsPath = path.join(dataDir, 'simulations.jsonl')
  const logsPath = path.join(dataDir, 'logs.jsonl')
  const auditPath = path.join(dataDir, 'audit-events.jsonl')
  const authAttemptsPath = path.join(dataDir, 'auth-attempts.jsonl')

  return {
    async createParticipant(input, invite) {
      const participantId = compactId('beta')
      const roomId = `beta-${participantId}`
      const record: BetaParticipantRecord = {
        schema_version: 1,
        participantId,
        roomId,
        createdAt: new Date().toISOString(),
        name: input.name,
        email: input.email,
        city: input.city,
        country: input.country,
        networkLabel: input.networkLabel,
        consentToCredit: input.consentToCredit,
        contributionNote: input.contributionNote,
        inviteTokenId: invite?.tokenId,
        inviteTokenLabel: invite?.label,
        inviteTokenHash: invite?.tokenHash,
      }
      await appendJsonl(participantsPath, record)
      return record
    },

    async createSession(participant, sessionToken) {
      const record: BetaSessionRecord = {
        schema_version: 1,
        sessionTokenHash: hashToken(sessionToken),
        participantId: participant.participantId,
        roomId: participant.roomId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        revokedAt: null,
      }
      await appendJsonl(sessionsPath, record)
      return record
    },

    async readSession(sessionToken) {
      const tokenHash = hashToken(sessionToken)
      const sessions = await readJsonl<BetaSessionRecord>(sessionsPath)
      const found = sessions.find((session) =>
        session.sessionTokenHash === tokenHash &&
        !session.revokedAt &&
        new Date(session.expiresAt).getTime() > Date.now()
      )
      return found ?? null
    },

    async appendEvidence(input) {
      const record: BetaEvidenceRecord = {
        schema_version: 1,
        evidenceId: compactId('evidence'),
        createdAt: new Date().toISOString(),
        participantId: input.participantId,
        roomId: input.roomId,
        topologyLabel: input.topologyLabel,
        result: input.result,
        notes: input.notes,
        telemetry: input.telemetry ?? [],
        storagePressure: input.storagePressure,
        runtimeConfig: input.runtimeConfig,
        lifecycleSignals: input.lifecycleSignals ?? [],
        deviceHints: input.deviceHints,
      }
      await appendJsonl(evidencePath, record)
      return record
    },

    async createToken(input) {
      const token = createPlainToken(input.role)
      const record: BetaTokenRecord & { token: string } = {
        schema_version: 1,
        tokenId: compactId('token'),
        tokenHash: hashToken(token),
        tokenPreview: previewToken(token),
        token,
        role: input.role,
        label: input.label.slice(0, 120),
        assignedName: input.assignedName,
        assignedEmail: input.assignedEmail,
        welcomeNote: input.welcomeNote,
        maxSessions: input.maxSessions,
        createdAt: new Date().toISOString(),
        createdBy: input.createdBy,
        active: true,
        revokedAt: null,
        revokedBy: null,
        expiresAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        lastUsedUserAgent: null,
        useCount: 0,
      }
      const { token: _token, ...persisted } = record
      await appendJsonl(tokensPath, persisted)
      return record
    },

    async readTokens() {
      return (await readJsonl<BetaTokenRecord>(tokensPath)).map((token) => ({
        ...token,
        active: token.active !== false,
        revokedAt: token.revokedAt ?? null,
        revokedBy: token.revokedBy ?? null,
        expiresAt: token.expiresAt ?? null,
        useCount: token.useCount ?? 0,
      }))
    },

    async readParticipants() {
      return await readJsonl<BetaParticipantRecord>(participantsPath)
    },

    async createRun(input, createdBy) {
      const runId = compactId('run')
      const record: BetaRunRecord = {
        schema_version: 1,
        runId,
        roomId: `beta-${runId}`,
        status: 'ready',
        createdAt: new Date().toISOString(),
        createdBy,
        title: input.title,
        scenario: input.scenario,
        dataType: input.dataType,
        nodeCount: input.nodeCount,
        notes: input.notes,
      }
      await appendJsonl(runsPath, record)
      return record
    },

    async readRuns() {
      return await readJsonl<BetaRunRecord>(runsPath)
    },

    async createSimulation(run, createdBy, requestCount = 40) {
      const simulation = buildSimulation(run, createdBy, requestCount)
      await appendJsonl(simulationsPath, simulation)
      return simulation
    },

    async readSimulations() {
      return await readJsonl<BetaSimulationRecord>(simulationsPath)
    },

    async appendLog(input, tokenRole) {
      const record: BetaLogRecord = {
        schema_version: 1,
        logId: compactId('log'),
        createdAt: new Date().toISOString(),
        tokenRole,
        participantId: input.participantId,
        roomId: input.roomId,
        runId: input.runId,
        level: input.level,
        message: input.message,
        details: input.details,
      }
      await appendJsonl(logsPath, record)
      return record
    },

    async readLogs() {
      return await readJsonl<BetaLogRecord>(logsPath)
    },

    async revokeToken(tokenId, revokedBy) {
      const tokens = await this.readTokens()
      const revokedAt = new Date().toISOString()
      let revoked: BetaTokenRecord | null = null
      const next = tokens.map((token) => {
        if (token.tokenId !== tokenId) return token
        revoked = { ...token, active: false, revokedAt, revokedBy }
        return revoked
      })
      if (revoked) await writeJsonl(tokensPath, next)
      return revoked
    },

    async recordTokenUse(tokenHash, metadata) {
      const tokens = await this.readTokens()
      let changed = false
      const next = tokens.map((token) => {
        if (token.tokenHash !== tokenHash) return token
        changed = true
        return {
          ...token,
          lastUsedAt: new Date().toISOString(),
          lastUsedIp: metadata?.ipAddress,
          lastUsedUserAgent: metadata?.userAgent,
          useCount: (token.useCount ?? 0) + 1,
        }
      })
      if (changed) await writeJsonl(tokensPath, next)
    },

    async appendAuditEvent(input) {
      const record: BetaAuditEventRecord = {
        schema_version: 1,
        eventId: compactId('audit'),
        eventType: input.eventType.slice(0, 120),
        severity: input.severity ?? 'info',
        actorTokenHash: input.actorTokenHash,
        actorRole: input.actorRole,
        targetType: input.targetType,
        targetId: input.targetId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        details: input.details,
        createdAt: new Date().toISOString(),
      }
      await appendJsonl(auditPath, record)
      return record
    },

    async readAuditEvents(limit = 100) {
      const events = await readJsonl<BetaAuditEventRecord>(auditPath)
      return events.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-limit)
    },

    async appendAuthAttempt(input) {
      const record: BetaAuthAttemptRecord = {
        schema_version: 1,
        attemptId: compactId('attempt'),
        tokenHash: input.tokenHash,
        tokenPreview: input.tokenPreview,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        success: input.success,
        failureReason: input.failureReason,
        createdAt: new Date().toISOString(),
      }
      await appendJsonl(authAttemptsPath, record)
      return record
    },

    async countRecentFailedAuthAttempts(tokenHash, sinceIso) {
      const attempts = await readJsonl<BetaAuthAttemptRecord>(authAttemptsPath)
      return attempts.filter((attempt) =>
        attempt.tokenHash === tokenHash &&
        !attempt.success &&
        attempt.createdAt >= sinceIso
      ).length
    },

    async readLedger() {
      const [participants, evidence] = await Promise.all([
        readJsonl<BetaParticipantRecord>(participantsPath),
        readJsonl<BetaEvidenceRecord>(evidencePath),
      ])

      const participantsWithEvidence = participants.map((participant) => {
        const participantEvidence = evidence.filter((item) => item.participantId === participant.participantId)
        const latestEvidenceAt = participantEvidence
          .map((item) => item.createdAt)
          .sort()
          .at(-1) ?? null
        return {
          ...participant,
          evidenceCount: participantEvidence.length,
          latestEvidenceAt,
        }
      })

      return {
        schema_version: 1,
        generatedAt: new Date().toISOString(),
        notice: 'Contributor ledger for research attribution and attorney review; not a legal inventorship determination.',
        participants: participantsWithEvidence,
        evidence,
      }
    },
  }
}

function requireSupabaseClient(): SupabaseClient {
  const url = process.env['SUPABASE_URL']
  const key = process.env['SUPABASE_SECRET_KEY'] ?? process.env['SUPABASE_SERVICE_ROLE_KEY']
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY are required for Supabase storage.')
  }
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}

function assertSupabase<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message)
  if (data === null) throw new Error('Supabase returned no data.')
  return data
}

function tokenFromRow(row: Record<string, unknown>): BetaTokenRecord {
  return {
    schema_version: 1,
    tokenId: String(row['id']),
    tokenHash: String(row['token_hash']),
    tokenPreview: String(row['token_preview']),
    role: row['role'] as BetaTokenRole,
    label: String(row['label']),
    assignedName: row['assigned_name'] as string | undefined,
    assignedEmail: row['assigned_email'] as string | undefined,
    welcomeNote: row['welcome_note'] as string | undefined,
    maxSessions: Number(row['max_sessions'] ?? 1),
    createdAt: String(row['created_at']),
    createdBy: String(row['created_by']),
    active: row['active'] !== false,
    expiresAt: row['expires_at'] as string | null,
    revokedAt: row['revoked_at'] as string | null,
    revokedBy: row['revoked_by'] as string | null,
    lastUsedAt: row['last_used_at'] as string | null,
    lastUsedIp: row['last_used_ip'] as string | null,
    lastUsedUserAgent: row['last_used_user_agent'] as string | null,
    useCount: Number(row['use_count'] ?? 0),
  }
}

function participantFromRow(row: Record<string, unknown>): BetaParticipantRecord {
  return {
    schema_version: 1,
    participantId: String(row['participant_id']),
    roomId: String(row['room_id']),
    createdAt: String(row['created_at']),
    name: String(row['name']),
    email: row['email'] as string | undefined,
    city: row['city'] as string | undefined,
    country: row['country'] as string | undefined,
    networkLabel: row['network_label'] as string | undefined,
    consentToCredit: row['consent_to_credit'] === true,
    contributionNote: row['contribution_note'] as string | undefined,
    inviteTokenId: row['invite_token_id'] as string | undefined,
    inviteTokenLabel: row['invite_token_label'] as string | undefined,
    inviteTokenHash: row['invite_token_hash'] as string | undefined,
  }
}

function evidenceFromRow(row: Record<string, unknown>): BetaEvidenceRecord {
  return {
    schema_version: 1,
    evidenceId: String(row['evidence_id']),
    createdAt: String(row['created_at']),
    participantId: String(row['participant_id']),
    roomId: String(row['room_id']),
    topologyLabel: String(row['topology_label']),
    result: row['result'] as BetaEvidenceResult,
    notes: row['notes'] as string | undefined,
    telemetry: Array.isArray(row['telemetry']) ? row['telemetry'] : [],
    storagePressure: row['storage_pressure'],
    runtimeConfig: row['runtime_config'],
    lifecycleSignals: Array.isArray(row['lifecycle_signals']) ? row['lifecycle_signals'] : [],
    deviceHints: row['device_hints'],
  }
}

function runFromRow(row: Record<string, unknown>): BetaRunRecord {
  return {
    schema_version: 1,
    runId: String(row['run_id']),
    roomId: String(row['room_id']),
    status: row['status'] as BetaRunRecord['status'],
    createdAt: String(row['created_at']),
    createdBy: String(row['created_by']),
    title: row['title'] as string | undefined,
    scenario: String(row['scenario']),
    dataType: String(row['data_type']),
    nodeCount: Number(row['node_count']),
    notes: row['notes'] as string | undefined,
  }
}

function simulationFromRow(row: Record<string, unknown>): BetaSimulationRecord {
  return {
    schema_version: 1,
    simulationId: String(row['simulation_id']),
    runId: String(row['run_id']),
    roomId: String(row['room_id']),
    scenario: String(row['scenario']),
    dataType: String(row['data_type']),
    nodeCount: Number(row['node_count']),
    requestCount: Number(row['request_count']),
    status: row['status'] as BetaSimulationRecord['status'],
    createdAt: String(row['created_at']),
    createdBy: String(row['created_by']),
    metrics: row['metrics'] as unknown as BetaSimulationMetrics,
    events: Array.isArray(row['events']) ? row['events'] as BetaSimulationEvent[] : [],
  }
}

function logFromRow(row: Record<string, unknown>): BetaLogRecord {
  return {
    schema_version: 1,
    logId: String(row['log_id']),
    createdAt: String(row['created_at']),
    tokenRole: row['token_role'] as BetaTokenRole,
    participantId: row['participant_id'] as string | undefined,
    roomId: row['room_id'] as string | undefined,
    runId: row['run_id'] as string | undefined,
    level: row['level'] as BetaLogInput['level'],
    message: String(row['message']),
    details: row['details'],
  }
}

function auditEventFromRow(row: Record<string, unknown>): BetaAuditEventRecord {
  return {
    schema_version: 1,
    eventId: String(row['event_id']),
    eventType: String(row['event_type']),
    severity: row['severity'] as BetaLogInput['level'],
    actorTokenHash: row['actor_token_hash'] as string | undefined,
    actorRole: row['actor_role'] as BetaTokenRole | undefined,
    targetType: row['target_type'] as string | undefined,
    targetId: row['target_id'] as string | undefined,
    ipAddress: row['ip_address'] as string | undefined,
    userAgent: row['user_agent'] as string | undefined,
    details: row['details'],
    createdAt: String(row['created_at']),
  }
}

function authAttemptFromRow(row: Record<string, unknown>): BetaAuthAttemptRecord {
  return {
    schema_version: 1,
    attemptId: String(row['id']),
    tokenHash: row['token_hash'] as string | undefined,
    tokenPreview: row['token_preview'] as string | undefined,
    ipAddress: row['ip_address'] as string | undefined,
    userAgent: row['user_agent'] as string | undefined,
    success: row['success'] === true,
    failureReason: row['failure_reason'] as string | undefined,
    createdAt: String(row['created_at']),
  }
}

export function createSupabaseBetaStore(client = requireSupabaseClient()): BetaStore {
  return {
    async createParticipant(input, invite) {
      const participantId = compactId('beta')
      const roomId = `beta-${participantId}`
      const inserted = await client
        .from('beta_participants')
        .insert({
          participant_id: participantId,
          room_id: roomId,
          invite_token_id: uuidOrNull(invite?.tokenId),
          invite_token_hash: invite?.tokenHash,
          invite_token_label: invite?.label,
          name: input.name,
          email: input.email,
          city: input.city,
          country: input.country,
          network_label: input.networkLabel,
          consent_to_credit: input.consentToCredit,
          contribution_note: input.contributionNote,
        })
        .select()
        .single()
      return participantFromRow(assertSupabase(inserted.data as Record<string, unknown> | null, inserted.error))
    },

    async createSession(participant, sessionToken) {
      const inserted = await client
        .from('beta_sessions')
        .insert({
          session_token_hash: hashToken(sessionToken),
          participant_id: participant.participantId,
          room_id: participant.roomId,
        })
        .select()
        .single()
      const row = assertSupabase(inserted.data as Record<string, unknown> | null, inserted.error)
      return {
        schema_version: 1,
        sessionTokenHash: String(row['session_token_hash']),
        participantId: String(row['participant_id']),
        roomId: String(row['room_id']),
        createdAt: String(row['created_at']),
        expiresAt: String(row['expires_at']),
        revokedAt: row['revoked_at'] as string | null,
      }
    },

    async readSession(sessionToken) {
      const selected = await client
        .from('beta_sessions')
        .select('*')
        .eq('session_token_hash', hashToken(sessionToken))
        .is('revoked_at', null)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle()
      if (selected.error) throw new Error(selected.error.message)
      if (!selected.data) return null
      const row = selected.data as Record<string, unknown>
      return {
        schema_version: 1,
        sessionTokenHash: String(row['session_token_hash']),
        participantId: String(row['participant_id']),
        roomId: String(row['room_id']),
        createdAt: String(row['created_at']),
        expiresAt: String(row['expires_at']),
        revokedAt: row['revoked_at'] as string | null,
      }
    },

    async appendEvidence(input) {
      const evidenceId = compactId('evidence')
      const inserted = await client
        .from('beta_evidence')
        .insert({
          evidence_id: evidenceId,
          participant_id: input.participantId,
          room_id: input.roomId,
          topology_label: input.topologyLabel,
          result: input.result,
          notes: input.notes,
          telemetry: input.telemetry ?? [],
          storage_pressure: input.storagePressure,
          runtime_config: input.runtimeConfig,
          lifecycle_signals: input.lifecycleSignals ?? [],
          device_hints: input.deviceHints,
        })
        .select()
        .single()
      return evidenceFromRow(assertSupabase(inserted.data as Record<string, unknown> | null, inserted.error))
    },

    async createToken(input) {
      const token = createPlainToken(input.role)
      const inserted = await client
        .from('beta_tokens')
        .insert({
          token_hash: hashToken(token),
          token_preview: previewToken(token),
          role: input.role,
          label: input.label.slice(0, 120),
          assigned_name: input.assignedName,
          assigned_email: input.assignedEmail,
          welcome_note: input.welcomeNote,
          max_sessions: input.maxSessions,
          created_by: input.createdBy,
          active: true,
        })
        .select()
        .single()
      return { ...tokenFromRow(assertSupabase(inserted.data as Record<string, unknown> | null, inserted.error)), token }
    },

    async readTokens() {
      const selected = await client.from('beta_tokens').select('*').order('created_at', { ascending: true })
      if (selected.error) throw new Error(selected.error.message)
      return ((selected.data ?? []) as Array<Record<string, unknown>>).map(tokenFromRow)
    },

    async readParticipants() {
      const selected = await client.from('beta_participants').select('*').order('created_at', { ascending: true })
      if (selected.error) throw new Error(selected.error.message)
      return ((selected.data ?? []) as Array<Record<string, unknown>>).map(participantFromRow)
    },

    async createRun(input, createdBy) {
      const runId = compactId('run')
      const inserted = await client
        .from('beta_runs')
        .insert({
          run_id: runId,
          room_id: `beta-${runId}`,
          status: 'ready',
          title: input.title,
          scenario: input.scenario,
          data_type: input.dataType,
          node_count: input.nodeCount,
          notes: input.notes,
          created_by: createdBy,
        })
        .select()
        .single()
      return runFromRow(assertSupabase(inserted.data as Record<string, unknown> | null, inserted.error))
    },

    async readRuns() {
      const selected = await client.from('beta_runs').select('*').order('created_at', { ascending: true })
      if (selected.error) throw new Error(selected.error.message)
      return ((selected.data ?? []) as Array<Record<string, unknown>>).map(runFromRow)
    },

    async createSimulation(run, createdBy, requestCount = 40) {
      const simulation = buildSimulation(run, createdBy, requestCount)
      const inserted = await client
        .from('beta_simulations')
        .insert({
          simulation_id: simulation.simulationId,
          run_id: simulation.runId,
          room_id: simulation.roomId,
          scenario: simulation.scenario,
          data_type: simulation.dataType,
          node_count: simulation.nodeCount,
          request_count: simulation.requestCount,
          status: simulation.status,
          metrics: simulation.metrics,
          events: simulation.events,
          created_by: simulation.createdBy,
        })
        .select()
        .single()
      return simulationFromRow(assertSupabase(inserted.data as Record<string, unknown> | null, inserted.error))
    },

    async readSimulations() {
      const selected = await client.from('beta_simulations').select('*').order('created_at', { ascending: true })
      if (selected.error) throw new Error(selected.error.message)
      return ((selected.data ?? []) as Array<Record<string, unknown>>).map(simulationFromRow)
    },

    async appendLog(input, tokenRole) {
      const logId = compactId('log')
      const inserted = await client
        .from('beta_logs')
        .insert({
          log_id: logId,
          participant_id: input.participantId,
          room_id: input.roomId,
          run_id: input.runId,
          token_role: tokenRole,
          level: input.level,
          message: input.message,
          details: input.details,
        })
        .select()
        .single()
      return logFromRow(assertSupabase(inserted.data as Record<string, unknown> | null, inserted.error))
    },

    async readLogs() {
      const selected = await client.from('beta_logs').select('*').order('created_at', { ascending: true })
      if (selected.error) throw new Error(selected.error.message)
      return ((selected.data ?? []) as Array<Record<string, unknown>>).map(logFromRow)
    },

    async revokeToken(tokenId, revokedBy) {
      const updated = await client
        .from('beta_tokens')
        .update({
          active: false,
          revoked_at: new Date().toISOString(),
          revoked_by: revokedBy,
        })
        .eq('id', tokenId)
        .select()
        .maybeSingle()
      if (updated.error) throw new Error(updated.error.message)
      return updated.data ? tokenFromRow(updated.data as Record<string, unknown>) : null
    },

    async recordTokenUse(tokenHash, metadata) {
      const selected = await client
        .from('beta_tokens')
        .select('id,use_count')
        .eq('token_hash', tokenHash)
        .maybeSingle()
      if (selected.error) throw new Error(selected.error.message)
      if (!selected.data) return
      const row = selected.data as Record<string, unknown>
      const updated = await client
        .from('beta_tokens')
        .update({
          last_used_at: new Date().toISOString(),
          last_used_ip: metadata?.ipAddress,
          last_used_user_agent: metadata?.userAgent,
          use_count: Number(row['use_count'] ?? 0) + 1,
        })
        .eq('id', String(row['id']))
      if (updated.error) throw new Error(updated.error.message)
    },

    async appendAuditEvent(input) {
      const eventId = compactId('audit')
      const inserted = await client
        .from('beta_audit_events')
        .insert({
          event_id: eventId,
          event_type: input.eventType.slice(0, 120),
          severity: input.severity ?? 'info',
          actor_token_hash: input.actorTokenHash,
          actor_role: input.actorRole,
          target_type: input.targetType,
          target_id: input.targetId,
          ip_address: input.ipAddress,
          user_agent: input.userAgent,
          details: input.details ?? {},
        })
        .select()
        .single()
      return auditEventFromRow(assertSupabase(inserted.data as Record<string, unknown> | null, inserted.error))
    },

    async readAuditEvents(limit = 100) {
      const selected = await client
        .from('beta_audit_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit)
      if (selected.error) throw new Error(selected.error.message)
      return ((selected.data ?? []) as Array<Record<string, unknown>>).map(auditEventFromRow).reverse()
    },

    async appendAuthAttempt(input) {
      const inserted = await client
        .from('beta_auth_attempts')
        .insert({
          token_hash: input.tokenHash,
          token_preview: input.tokenPreview,
          ip_address: input.ipAddress,
          user_agent: input.userAgent,
          success: input.success,
          failure_reason: input.failureReason,
        })
        .select()
        .single()
      return authAttemptFromRow(assertSupabase(inserted.data as Record<string, unknown> | null, inserted.error))
    },

    async countRecentFailedAuthAttempts(tokenHash, sinceIso) {
      const selected = await client
        .from('beta_auth_attempts')
        .select('id', { count: 'exact', head: true })
        .eq('token_hash', tokenHash)
        .eq('success', false)
        .gte('created_at', sinceIso)
      if (selected.error) throw new Error(selected.error.message)
      return selected.count ?? 0
    },

    async readLedger() {
      const [participants, evidence] = await Promise.all([
        this.readParticipants(),
        client.from('beta_evidence').select('*').order('created_at', { ascending: true }),
      ])
      if (evidence.error) throw new Error(evidence.error.message)
      const evidenceRows = ((evidence.data ?? []) as Array<Record<string, unknown>>).map(evidenceFromRow)
      return {
        schema_version: 1,
        generatedAt: new Date().toISOString(),
        notice: 'Contributor ledger for research attribution and attorney review; not a legal inventorship determination.',
        participants: participants.map((participant) => {
          const participantEvidence = evidenceRows.filter((item) => item.participantId === participant.participantId)
          return {
            ...participant,
            evidenceCount: participantEvidence.length,
            latestEvidenceAt: participantEvidence.map((item) => item.createdAt).sort().at(-1) ?? null,
          }
        }),
        evidence: evidenceRows,
      }
    },
  }
}

function createConfiguredBetaStore(dataDir: string): BetaStore {
  return process.env['NODEX_BETA_STORAGE_DRIVER'] === 'supabase'
    ? createSupabaseBetaStore()
    : createBetaStore(dataDir)
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length))
  return sorted[index] ?? 0
}

function sourceForRequest(index: number, scenario: string): BetaSimulationSource {
  if (scenario === 'server-fallback') return index % 5 === 0 ? 'server-fallback' : 'sw-cache'
  if (scenario === 'p2p-cache-hit') return index % 9 === 0 ? 'server-fallback' : index % 3 === 0 ? 'peer-fetch' : 'sw-cache'
  return index % 13 === 0 ? 'server-fallback' : index % 4 === 0 ? 'peer-fetch' : 'sw-cache'
}

function latencyForSource(source: BetaSimulationSource, index: number): number {
  if (source === 'sw-cache') return 2 + (index % 4)
  if (source === 'peer-fetch') return 12 + ((index * 3) % 15)
  return 65 + ((index * 7) % 42)
}

function buildSimulation(run: BetaRunRecord, createdBy: string, requestedCount: number): BetaSimulationRecord {
  const requestCount = Math.max(10, Math.min(200, Math.round(requestedCount)))
  const createdAt = new Date().toISOString()
  const events: BetaSimulationEvent[] = Array.from({ length: requestCount }, (_, index) => {
    const source = sourceForRequest(index, run.scenario)
    return {
      requestId: compactId('req'),
      key: `/api/beta-sim/${run.dataType}/${(index % 8) + 1}`,
      nodeId: `node-${(index % run.nodeCount) + 1}`,
      source,
      latencyMs: latencyForSource(source, index),
      seq: index + 1,
      gossipHop: source === 'server-fallback' ? 0 : (index % 4) + 1,
      createdAt,
    }
  })
  const swCache = events.filter((event) => event.source === 'sw-cache').length
  const peerFetch = events.filter((event) => event.source === 'peer-fetch').length
  const serverFallback = events.filter((event) => event.source === 'server-fallback').length
  const latencies = events.map((event) => event.latencyMs)
  const reachedNodes = new Set(events.filter((event) => event.source !== 'server-fallback').map((event) => event.nodeId)).size

  return {
    schema_version: 1,
    simulationId: compactId('sim'),
    runId: run.runId,
    roomId: run.roomId,
    scenario: run.scenario,
    dataType: run.dataType,
    nodeCount: run.nodeCount,
    requestCount,
    status: 'completed',
    createdAt,
    createdBy,
    metrics: {
      totalRequests: requestCount,
      swCache,
      peerFetch,
      serverFallback,
      hitRatePct: Number((((swCache + peerFetch) / requestCount) * 100).toFixed(2)),
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      invalidationReachPct: Number(((reachedNodes / run.nodeCount) * 100).toFixed(2)),
      estimatedOriginReadsAvoided: swCache + peerFetch,
    },
    events,
  }
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() ?? null
}

function isTokenUsable(record: BetaTokenRecord): boolean {
  if (!record.active || record.revokedAt) return false
  if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) return false
  return true
}

function requestMeta(c: { req: { header(name: string): string | undefined } }): { ipAddress?: string; userAgent?: string } {
  const forwardedFor = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  const realIp = c.req.header('x-real-ip')?.trim()
  return {
    ipAddress: forwardedFor || realIp || undefined,
    userAgent: c.req.header('user-agent')?.slice(0, 500),
  }
}

function buildTestUrl(appOrigin: string, signalingUrl: string, roomId: string): string {
  const url = new URL(appOrigin)
  url.searchParams.set('nodexRoom', roomId)
  url.searchParams.set('nodexTopology', 'beta-external')
  url.searchParams.set('nodexSignalingUrl', signalingUrl)
  return url.toString()
}

export function createBetaCoordinatorApp(options: BetaCoordinatorOptions): Hono {
  const app = new Hono()
  const store = createConfiguredBetaStore(options.dataDir)
  const inviteTokens = new Set(options.inviteTokens.filter((token) => token.trim().length > 0))
  const adminTokens = new Set((options.adminTokens ?? []).filter((token) => token.trim().length > 0))
  const tokenMeta: Record<string, BetaTokenMeta> = options.tokenMeta ?? {}
  const appOrigin = options.appOrigin ?? 'http://localhost:4173/'
  const signalingUrl = options.signalingUrl ?? DEFAULT_SIGNALING_URL
  const allowedOrigins = new Set(options.allowedOrigins ?? [appOrigin.replace(/\/$/, '')])

  async function authorize(header: string | undefined, meta: { ipAddress?: string; userAgent?: string } = {}): Promise<{
    token: string
    tokenHash: string
    role: BetaTokenRole
    record?: BetaTokenRecord
  } | null> {
    const token = extractBearerToken(header)
    if (!token) return null
    const tokenHash = hashToken(token)
    const tokenPreview = previewToken(token)
    const sinceIso = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const failedAttempts = await store.countRecentFailedAuthAttempts(tokenHash, sinceIso).catch(() => 0)
    if (failedAttempts >= 8) {
      await store.appendAuthAttempt({
        tokenHash,
        tokenPreview,
        success: false,
        failureReason: 'rate_limited',
        ...meta,
      }).catch(() => undefined)
      await store.appendAuditEvent({
        eventType: 'auth_rate_limited',
        severity: 'warn',
        actorTokenHash: tokenHash,
        targetType: 'token',
        targetId: tokenPreview,
        details: { failedAttempts },
        ...meta,
      }).catch(() => undefined)
      return null
    }
    if (adminTokens.has(token)) return { token, tokenHash, role: 'admin' }
    if (inviteTokens.has(token)) {
      const meta = tokenMeta[token]
      if (meta) {
        const syntheticRecord: BetaTokenRecord = {
          schema_version: 1,
          tokenId: hashToken(token).slice(0, 16),
          tokenHash,
          tokenPreview: previewToken(token),
          role: 'tester',
          label: meta.assignedName ?? 'Beta tester',
          assignedName: meta.assignedName,
          assignedEmail: meta.assignedEmail,
          welcomeNote: meta.welcomeNote,
          maxSessions: 1,
          createdAt: '',
          createdBy: 'env',
          active: true,
        }
        return { token, tokenHash, role: 'tester', record: syntheticRecord }
      }
      return { token, tokenHash, role: 'tester' }
    }
    const created = (await store.readTokens()).find((record) => record.tokenHash === tokenHash)
    if (created && isTokenUsable(created)) {
      await store.recordTokenUse(tokenHash, meta).catch(() => undefined)
      await store.appendAuthAttempt({ tokenHash, tokenPreview, success: true, ...meta }).catch(() => undefined)
      return { token, tokenHash, role: created.role, record: created }
    }
    await store.appendAuthAttempt({
      tokenHash,
      tokenPreview,
      success: false,
      failureReason: created ? 'token_inactive_or_expired' : 'token_not_found',
      ...meta,
    }).catch(() => undefined)
    await store.appendAuditEvent({
      eventType: 'auth_failed',
      severity: 'warn',
      actorTokenHash: tokenHash,
      targetType: 'token',
      targetId: tokenPreview,
      details: { reason: created ? 'token_inactive_or_expired' : 'token_not_found' },
      ...meta,
    }).catch(() => undefined)
    return null
  }

  async function requireAdmin(header: string | undefined, meta: { ipAddress?: string; userAgent?: string } = {}): Promise<{ token: string; role: 'admin'; tokenHash: string } | null> {
    const auth = await authorize(header, meta)
    return auth?.role === 'admin' ? { token: auth.token, tokenHash: auth.tokenHash, role: 'admin' } : null
  }

  app.use('*', async (c, next) => {
    const origin = c.req.header('Origin')
    if (origin && allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
      return c.json({ error: 'origin not allowed' }, 403)
    }
    await next()
  })
  app.use('*', cors({
    origin: (origin) => {
      if (!origin) return '*'
      return allowedOrigins.has(origin) ? origin : appOrigin.replace(/\/$/, '')
    },
  }))

  app.get('/api/beta/health', (c) => c.json({
    ok: true,
    invite_tokens_configured: inviteTokens.size,
    admin_tokens_configured: adminTokens.size,
    allowed_origins_configured: allowedOrigins.size,
  }))

  app.post('/api/beta/auth', async (c) => {
    const auth = await authorize(c.req.header('Authorization'), requestMeta(c))
    if (!auth) return c.json({ error: 'invalid beta token' }, 401)
    return c.json({
      role: auth.role,
      tokenPreview: previewToken(auth.token),
      invite: auth.record
        ? {
            label: auth.record.label,
            assignedName: auth.record.assignedName,
            assignedEmail: auth.record.assignedEmail,
            welcomeNote: auth.record.welcomeNote,
            maxSessions: auth.record.maxSessions,
          }
        : null,
    })
  })

  app.post('/api/beta/sessions', async (c) => {
    const meta = requestMeta(c)
    const auth = await authorize(c.req.header('Authorization'), meta)
    if (!auth) {
      return c.json({ error: 'invalid beta invite token' }, 401)
    }

    const input = sanitizeParticipantInput(await c.req.json().catch(() => null))
    if (!input) {
      return c.json({ error: 'name is required' }, 400)
    }

    if (auth.record?.role === 'tester') {
      const participants = await store.readParticipants()
      const usedSessions = participants.filter((participant) => participant.inviteTokenHash === auth.tokenHash).length
      if (usedSessions >= auth.record.maxSessions) {
        return c.json({ error: 'this tester token has already been used' }, 409)
      }
    }

    const participant = await store.createParticipant(input, auth.record
      ? { tokenId: auth.record.tokenId, tokenHash: auth.record.tokenHash, label: auth.record.label }
      : undefined)
    const sessionToken = compactId('beta-session')
    await store.createSession(participant, sessionToken)
    await store.appendAuditEvent({
      eventType: 'beta_session_created',
      actorTokenHash: auth.tokenHash,
      actorRole: auth.role,
      targetType: 'participant',
      targetId: participant.participantId,
      details: { roomId: participant.roomId, tokenPreview: previewToken(auth.token) },
      ...meta,
    }).catch(() => undefined)

    return c.json({
      participantId: participant.participantId,
      sessionToken,
      roomId: participant.roomId,
      testUrl: buildTestUrl(appOrigin, signalingUrl, participant.roomId),
      ledgerNotice: 'Saved as contributor/test-participant evidence, not a legal inventorship determination.',
    }, 201)
  })

  app.post('/api/beta/evidence', async (c) => {
    const sessionToken = extractBearerToken(c.req.header('Authorization'))
    const session = sessionToken ? await store.readSession(sessionToken) : null
    if (!session) {
      return c.json({ error: 'invalid beta session token' }, 401)
    }

    const input = sanitizeEvidenceInput(await c.req.json().catch(() => null))
    if (!input || input.participantId !== session.participantId || input.roomId !== session.roomId) {
      return c.json({ error: 'evidence does not match active session' }, 400)
    }

    const evidence = await store.appendEvidence(input)
    return c.json({ evidenceId: evidence.evidenceId, createdAt: evidence.createdAt }, 201)
  })

  app.get('/api/beta/ledger', async (c) => {
    const auth = await requireAdmin(c.req.header('Authorization'), requestMeta(c))
    if (!auth) {
      return c.json({ error: 'admin token required' }, 403)
    }
    return c.json(await store.readLedger())
  })

  app.get('/api/beta/tokens', async (c) => {
    const auth = await requireAdmin(c.req.header('Authorization'), requestMeta(c))
    if (!auth) return c.json({ error: 'admin token required' }, 403)
    const createdTokens = await store.readTokens()
    return c.json({
      environment: [
        { role: 'admin', count: adminTokens.size },
        { role: 'tester', count: inviteTokens.size },
      ],
      createdTokens,
    })
  })

  app.post('/api/beta/tokens', async (c) => {
    const meta = requestMeta(c)
    const auth = await requireAdmin(c.req.header('Authorization'), meta)
    if (!auth) return c.json({ error: 'admin token required' }, 403)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const tokenInput = sanitizeTokenCreateInput(body)
    const token = await store.createToken({ ...tokenInput, createdBy: previewToken(auth.token) })
    await store.appendAuditEvent({
      eventType: 'token_created',
      actorTokenHash: auth.tokenHash,
      actorRole: auth.role,
      targetType: 'token',
      targetId: token.tokenId,
      details: {
        role: token.role,
        label: token.label,
        tokenPreview: token.tokenPreview,
        assignedEmail: token.assignedEmail,
        maxSessions: token.maxSessions,
      },
      ...meta,
    }).catch(() => undefined)
    return c.json(token, 201)
  })

  app.post('/api/beta/tokens/:tokenId/revoke', async (c) => {
    const meta = requestMeta(c)
    const auth = await requireAdmin(c.req.header('Authorization'), meta)
    if (!auth) return c.json({ error: 'admin token required' }, 403)
    const tokenId = c.req.param('tokenId')
    const revoked = await store.revokeToken(tokenId, previewToken(auth.token))
    if (!revoked) return c.json({ error: 'token not found' }, 404)
    await store.appendAuditEvent({
      eventType: 'token_revoked',
      actorTokenHash: auth.tokenHash,
      actorRole: auth.role,
      targetType: 'token',
      targetId: tokenId,
      severity: 'warn',
      details: { tokenPreview: revoked.tokenPreview, label: revoked.label, role: revoked.role },
      ...meta,
    }).catch(() => undefined)
    return c.json({ token: revoked })
  })

  app.get('/api/beta/audit', async (c) => {
    const auth = await requireAdmin(c.req.header('Authorization'), requestMeta(c))
    if (!auth) return c.json({ error: 'admin token required' }, 403)
    return c.json({ events: await store.readAuditEvents(100) })
  })

  app.get('/api/beta/runs', async (c) => {
    const auth = await requireAdmin(c.req.header('Authorization'), requestMeta(c))
    if (!auth) return c.json({ error: 'admin token required' }, 403)
    return c.json({ runs: await store.readRuns() })
  })

  app.get('/api/beta/rooms', async (c) => {
    const auth = await authorize(c.req.header('Authorization'), requestMeta(c))
    if (!auth) return c.json({ error: 'invalid token' }, 401)
    const rooms = (await store.readRuns())
      .filter((run) => run.status === 'ready' || run.status === 'running')
      .map((run) => ({
        runId: run.runId,
        roomId: run.roomId,
        title: run.title,
        scenario: run.scenario,
        dataType: run.dataType,
        nodeCount: run.nodeCount,
        status: run.status,
        createdAt: run.createdAt,
      }))
    return c.json({ rooms })
  })

  app.post('/api/beta/runs', async (c) => {
    const meta = requestMeta(c)
    const auth = await requireAdmin(c.req.header('Authorization'), meta)
    if (!auth) return c.json({ error: 'admin token required' }, 403)
    const input = sanitizeRunInput(await c.req.json().catch(() => null))
    if (!input) return c.json({ error: 'scenario, dataType, and nodeCount are required' }, 400)
    const run = await store.createRun(input, previewToken(auth.token))
    const simulation = await store.createSimulation(run, previewToken(auth.token))
    await store.appendAuditEvent({
      eventType: 'run_created',
      actorTokenHash: auth.tokenHash,
      actorRole: auth.role,
      targetType: 'run',
      targetId: run.runId,
      details: { scenario: run.scenario, dataType: run.dataType, nodeCount: run.nodeCount },
      ...meta,
    }).catch(() => undefined)
    return c.json({
      ...run,
      testUrl: buildTestUrl(appOrigin, signalingUrl, run.roomId),
      simulation,
    }, 201)
  })

  app.get('/api/beta/simulations', async (c) => {
    const auth = await requireAdmin(c.req.header('Authorization'), requestMeta(c))
    if (!auth) return c.json({ error: 'admin token required' }, 403)
    return c.json({ simulations: await store.readSimulations() })
  })

  app.post('/api/beta/simulations', async (c) => {
    const auth = await requireAdmin(c.req.header('Authorization'), requestMeta(c))
    if (!auth) return c.json({ error: 'admin token required' }, 403)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const input = sanitizeRunInput(body)
    if (!input) return c.json({ error: 'scenario, dataType, and nodeCount are required' }, 400)
    const requestCount = Number(body['requestCount'])
    const run = await store.createRun(input, previewToken(auth.token))
    const simulation = await store.createSimulation(run, previewToken(auth.token), Number.isFinite(requestCount) ? requestCount : undefined)
    return c.json({
      run,
      simulation,
      testUrl: buildTestUrl(appOrigin, signalingUrl, run.roomId),
    }, 201)
  })

  app.get('/api/beta/control', async (c) => {
    const auth = await requireAdmin(c.req.header('Authorization'), requestMeta(c))
    if (!auth) return c.json({ error: 'admin token required' }, 403)
    const [ledger, runs, logs, simulations] = await Promise.all([
      store.readLedger(),
      store.readRuns(),
      store.readLogs(),
      store.readSimulations(),
    ])
    return c.json({
      generatedAt: new Date().toISOString(),
      totals: {
        participants: ledger.participants.length,
        evidence: ledger.evidence.length,
        runs: runs.length,
        simulations: simulations.length,
        logs: logs.length,
      },
      latestRun: runs.at(-1) ?? null,
      latestSimulation: simulations.at(-1) ?? null,
      latestLogs: logs.slice(-8),
    })
  })

  app.get('/api/beta/logs', async (c) => {
    const auth = await requireAdmin(c.req.header('Authorization'), requestMeta(c))
    if (!auth) return c.json({ error: 'admin token required' }, 403)
    return c.json({ logs: await store.readLogs() })
  })

  app.post('/api/beta/logs', async (c) => {
    const auth = await authorize(c.req.header('Authorization'), requestMeta(c))
    if (!auth) return c.json({ error: 'invalid beta token' }, 401)
    const input = sanitizeLogInput(await c.req.json().catch(() => null))
    if (!input) return c.json({ error: 'log level and message are required' }, 400)
    const log = await store.appendLog(input, auth.role)
    return c.json({ logId: log.logId, createdAt: log.createdAt }, 201)
  })

  // ── Presence / lobby ────────────────────────────────────────────────────────
  // Lightweight heartbeat so testers can see who is online before multi-person
  // tests. Records are written to presence.jsonl; only entries within the last
  // 3 minutes are considered online. No auth bypass — every caller must have a
  // valid invite or admin token.

  const presencePath = path.join(options.dataDir, 'presence.jsonl')

  async function readOnlinePresence(roomId?: string): Promise<Array<{ name: string; role: BetaTokenRole; mode: string; lastSeen: string; participantId?: string; roomId?: string }>> {
    const all = await readJsonl<{ tokenHash: string; name: string; role: BetaTokenRole; mode: string; lastSeen: string; participantId?: string; roomId?: string }>(presencePath)
    const cutoffMs = Date.now() - 3 * 60 * 1000
    const latest = new Map<string, typeof all[0]>()
    for (const entry of all.filter((item) => !roomId || item.roomId === roomId)) {
      const existing = latest.get(entry.tokenHash)
      if (!existing || entry.lastSeen > existing.lastSeen) latest.set(entry.tokenHash, entry)
    }
    return Array.from(latest.values())
      .filter((e) => new Date(e.lastSeen).getTime() > cutoffMs)
      .map(({ name, role, mode, lastSeen, participantId, roomId }) => ({ name, role, mode, lastSeen, participantId, roomId }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  app.post('/api/beta/presence', async (c) => {
    const auth = await authorize(c.req.header('Authorization'), requestMeta(c))
    if (!auth) return c.json({ error: 'invalid token' }, 401)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const name = nonEmptyString(body['name']) ?? auth.record?.assignedName ?? (auth.role === 'admin' ? 'Admin' : 'Tester')
    const mode = nonEmptyString(body['mode']) ?? 'solo'
    const roomId = nonEmptyString(body['roomId'])?.slice(0, 160)
    const participantId = nonEmptyString(body['participantId'])?.slice(0, 120)
    const entry = {
      tokenHash: auth.tokenHash,
      name: name.slice(0, 80),
      role: auth.role,
      mode: mode.slice(0, 20),
      participantId,
      roomId,
      lastSeen: new Date().toISOString(),
    }
    await appendJsonl(presencePath, entry).catch(() => undefined)
    const online = await readOnlinePresence(roomId)
    return c.json({ online })
  })

  app.get('/api/beta/presence', async (c) => {
    const auth = await authorize(c.req.header('Authorization'), requestMeta(c))
    if (!auth) return c.json({ error: 'invalid token' }, 401)
    const roomId = c.req.query('roomId')?.slice(0, 160)
    const online = await readOnlinePresence(roomId)
    return c.json({ online })
  })

  // ── Interceptor captures ─────────────────────────────────────────────────────
  // Admin-only view of what crossed the wire: path, seq, IV, ciphertext sample.
  // Populated non-blocking by api/products/[id].ts on every encrypted response.

  app.get('/api/beta/interceptor', async (c) => {
    const auth = await requireAdmin(c.req.header('Authorization'), requestMeta(c))
    if (!auth) return c.json({ error: 'admin token required' }, 403)

    const blobKeyName = 'nodex-beta/interceptor-captures.jsonl'
    let captures: unknown[] = []
    try {
      if (useBlobStore()) {
        const blob = await get(blobKeyName, { access: 'private', useCache: false }).catch(() => null)
        if (blob?.stream) {
          const text = await new Response(blob.stream).text()
          captures = text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
        }
      }
    } catch { /* no captures yet */ }
    return c.json({ captures: captures.slice(-50) })
  })

  return app
}

function parseInviteTokens(): string[] {
  const raw = process.env['NODEX_BETA_TOKENS'] ?? ''
  return splitTokenEntries(raw).map((entry) => entry.split('|')[0]?.trim() ?? '').filter(Boolean)
}

export function parseInviteTokensWithMeta(): { tokens: string[]; tokenMeta: Record<string, BetaTokenMeta> } {
  const raw = process.env['NODEX_BETA_TOKENS'] ?? ''
  const tokens: string[] = []
  const tokenMeta: Record<string, BetaTokenMeta> = {}
  for (const entry of splitTokenEntries(raw)) {
    const parts = entry.split('|')
    const token = parts[0]?.trim()
    if (!token || !token.startsWith('nodex-') || token.length < 20) continue
    tokens.push(token)
    const assignedName = parts[1]?.trim() || undefined
    const assignedEmail = parts[2]?.trim() || undefined
    const welcomeNote = parts[3]?.trim() || undefined
    if (assignedName || assignedEmail || welcomeNote) {
      tokenMeta[token] = { assignedName, assignedEmail, welcomeNote }
    }
  }
  return { tokens, tokenMeta }
}

function splitTokenEntries(raw: string): string[] {
  return raw.split(/,(?=nodex-)/).map((entry) => entry.trim()).filter(Boolean)
}

function parseAdminTokens(): string[] {
  const raw = process.env['NODEX_BETA_ADMIN_TOKENS'] ?? ''
  return raw.split(',').map((token) => token.trim()).filter(Boolean)
}

function parseAllowedOrigins(): string[] {
  const raw = process.env['NODEX_BETA_ALLOWED_ORIGINS'] ?? process.env['NODEX_BETA_APP_ORIGIN'] ?? ''
  return raw.split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean)
}

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false

if (process.env['NODE_ENV'] !== 'test' && process.env['VERCEL'] !== '1' && isDirectRun) {
  const { tokens, tokenMeta } = parseInviteTokensWithMeta()
  const adminTokens = parseAdminTokens()
  if (tokens.length === 0) {
    console.warn('[Nodex Beta] NODEX_BETA_TOKENS is empty; beta session creation will reject all invites.')
  }
  if (adminTokens.length === 0) {
    console.warn('[Nodex Beta] NODEX_BETA_ADMIN_TOKENS is empty; admin console will reject all admin actions.')
  }

  serve({
    fetch: createBetaCoordinatorApp({
      dataDir: process.env['NODEX_BETA_DATA_DIR'] ?? 'beta-data',
      inviteTokens: tokens,
      adminTokens,
      tokenMeta,
      appOrigin: process.env['NODEX_BETA_APP_ORIGIN'] ?? 'http://localhost:4173/',
      signalingUrl: process.env['NODEX_BETA_SIGNALING_URL'] ?? DEFAULT_SIGNALING_URL,
      allowedOrigins: parseAllowedOrigins(),
    }).fetch,
    port: Number(process.env['NODEX_BETA_PORT'] ?? 3003),
  }, (info) => {
    console.log(`[Nodex Beta] Listening on http://localhost:${info.port}`)
  })
}
