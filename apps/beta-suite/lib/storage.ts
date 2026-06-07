'use client'

import type { BetaLogEvent, BetaSession, StoredAuth, TesterProfile } from './types'

const AUTH_KEY = 'nodex-next-auth-v1'
const SESSION_KEY = 'nodex-next-session-v1'
const LOG_KEY = 'nodex-next-logs-v1'
const ROOM_OPEN_KEY = 'nodex-next-room-open-v1'
const ACTIVE_ROOM_KEY = 'nodex-next-active-room-v1'
const RUN_EVIDENCE_KEY = 'nodex-next-run-evidence-v1'
let cachedAuth: StoredAuth | null = null

export interface StoredRunEvidence {
  topologyLabel: string
  resultHint: 'pass' | 'partial' | 'fail' | 'not_measured'
  telemetry: unknown[]
  storagePressure?: unknown
  runtimeConfig?: unknown
  lifecycleSignals: unknown[]
  deviceHints: unknown
  metrics?: unknown
  peerCount?: number
  p2pCapture?: unknown
  recordedAt: string
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value))
}

function profileKey(auth: StoredAuth): string {
  return `nodex-next-profile-v1:${auth.token}`
}

function legacyProfileKey(auth: StoredAuth): string {
  return `nodex-next-profile-v1:${auth.tokenPreview}`
}

export function readAuth(): StoredAuth | null {
  cachedAuth = readJson<StoredAuth>(AUTH_KEY)
  return cachedAuth
}

export function readCachedAuth(): StoredAuth | null {
  return cachedAuth
}

export function writeAuth(auth: StoredAuth): void {
  cachedAuth = auth
  writeJson(AUTH_KEY, auth)
}

export function clearAll(): void {
  cachedAuth = null
  localStorage.removeItem(AUTH_KEY)
  localStorage.removeItem(SESSION_KEY)
  localStorage.removeItem(LOG_KEY)
  localStorage.removeItem(ROOM_OPEN_KEY)
  localStorage.removeItem(ACTIVE_ROOM_KEY)
  localStorage.removeItem(RUN_EVIDENCE_KEY)
}

export function readSession(): BetaSession | null {
  return readJson<BetaSession>(SESSION_KEY)
}

export function writeSession(session: BetaSession): void {
  writeJson(SESSION_KEY, session)
}

export function readProfile(auth: StoredAuth): TesterProfile {
  const saved = readJson<Partial<TesterProfile>>(profileKey(auth)) ?? readJson<Partial<TesterProfile>>(legacyProfileKey(auth)) ?? {}
  return {
    name: saved.name ?? auth.invite?.assignedName ?? '',
    email: saved.email ?? auth.invite?.assignedEmail ?? '',
    city: saved.city ?? '',
    country: saved.country ?? '',
    networkLabel: saved.networkLabel ?? '',
    consentToCredit: saved.consentToCredit ?? false,
  }
}

export function writeProfile(auth: StoredAuth, profile: TesterProfile): void {
  writeJson(profileKey(auth), profile)
}

export function readLogs(): BetaLogEvent[] {
  return readJson<BetaLogEvent[]>(LOG_KEY) ?? []
}

export function addLog(message: string, level: BetaLogEvent['level'] = 'info', details?: unknown): BetaLogEvent[] {
  const logs = [...readLogs(), { time: new Date().toISOString(), level, message, details }].slice(-80)
  writeJson(LOG_KEY, logs)
  return logs
}

export function buildLogBundle(auth: StoredAuth | null, session: BetaSession | null) {
  return {
    schema_version: 1,
    generatedAt: new Date().toISOString(),
    role: auth?.role,
    tokenPreview: auth?.tokenPreview,
    participantId: session?.participantId,
    roomId: session?.roomId,
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
    pageUrl: typeof location === 'undefined' ? undefined : location.href,
    events: readLogs(),
  }
}

export function readRunEvidence(): StoredRunEvidence | null {
  return readJson<StoredRunEvidence>(RUN_EVIDENCE_KEY)
}

export function writeRunEvidence(evidence: StoredRunEvidence): void {
  writeJson(RUN_EVIDENCE_KEY, evidence)
}

export function isRoomOpen(): boolean {
  return localStorage.getItem(ROOM_OPEN_KEY) === '1'
}

export function setRoomOpen(open: boolean): void {
  if (open) localStorage.setItem(ROOM_OPEN_KEY, '1')
  else localStorage.removeItem(ROOM_OPEN_KEY)
}

export function writeActiveRoom(room: { roomId: string; mode: string }): void {
  writeJson(ACTIVE_ROOM_KEY, room)
}

export function readActiveRoom(): { roomId: string; mode: string } | null {
  return readJson<{ roomId: string; mode: string }>(ACTIVE_ROOM_KEY)
}
