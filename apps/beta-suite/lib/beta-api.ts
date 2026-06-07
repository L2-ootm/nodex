import type {
  AdminToken,
  AuditEvent,
  BetaLedger,
  BetaLogEvent,
  BetaRun,
  BetaRoom,
  BetaSession,
  EvidencePayload,
  PresencePeer,
  StoredAuth,
  TesterProfile,
} from './types'

const LOCAL_API_URL = 'http://localhost:3003'
const PRODUCTION_API_URL = 'https://nodex-beta-api.vercel.app'

export function betaApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_NODEX_BETA_API_URL
  if (configured) return configured.replace(/\/$/, '')
  if (typeof window === 'undefined') return LOCAL_API_URL
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? LOCAL_API_URL
    : PRODUCTION_API_URL
}

async function requestJson<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const response = await fetch(`${betaApiBase()}${path}`, { ...init, headers })
  const text = await response.text()
  const payload = text ? JSON.parse(text) as T & { error?: string } : {} as T & { error?: string }
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`)
  return payload as T
}

export function authenticate(token: string): Promise<Omit<StoredAuth, 'token'>> {
  return requestJson<Omit<StoredAuth, 'token'>>('/api/beta/auth', token, { method: 'POST' })
}

export function createSession(token: string, profile: TesterProfile & { contributionNote?: string }): Promise<BetaSession> {
  return requestJson<BetaSession>('/api/beta/sessions', token, {
    method: 'POST',
    body: JSON.stringify({
      name: profile.name,
      email: profile.email || undefined,
      city: profile.city || undefined,
      country: profile.country || undefined,
      networkLabel: profile.networkLabel || undefined,
      consentToCredit: profile.consentToCredit,
      contributionNote: profile.contributionNote || undefined,
    }),
  })
}

export function submitEvidence(sessionToken: string, payload: EvidencePayload): Promise<{ evidenceId: string; createdAt?: string }> {
  return requestJson('/api/beta/evidence', sessionToken, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function sendLog(token: string, event: { runId?: string; participantId?: string; roomId?: string; level: BetaLogEvent['level']; message: string; details?: unknown }): Promise<{ logId: string }> {
  return requestJson('/api/beta/logs', token, {
    method: 'POST',
    body: JSON.stringify(event),
  })
}

export function postPresence(token: string, body: { name: string; mode: string; participantId?: string; roomId?: string }): Promise<{ online: PresencePeer[] }> {
  return requestJson('/api/beta/presence', token, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function listPresence(token: string, roomId: string): Promise<{ online: PresencePeer[] }> {
  return requestJson(`/api/beta/presence?roomId=${encodeURIComponent(roomId)}`, token)
}

export function listRooms(token: string): Promise<{ rooms: BetaRoom[] }> {
  return requestJson('/api/beta/rooms', token)
}

export function listTokens(token: string): Promise<{ environment: Array<{ role: string; count: number }>; createdTokens: AdminToken[] }> {
  return requestJson('/api/beta/tokens', token)
}

export function createToken(token: string, body: {
  label: string
  role: string
  assignedName?: string
  assignedEmail?: string
  welcomeNote?: string
  maxSessions: number
}): Promise<AdminToken & { token: string }> {
  return requestJson('/api/beta/tokens', token, { method: 'POST', body: JSON.stringify(body) })
}

export function revokeToken(token: string, tokenId: string): Promise<{ token: AdminToken }> {
  return requestJson(`/api/beta/tokens/${encodeURIComponent(tokenId)}/revoke`, token, { method: 'POST' })
}

export function listRuns(token: string): Promise<{ runs: BetaRun[] }> {
  return requestJson('/api/beta/runs', token)
}

export function createRun(token: string, body: { title?: string; scenario: string; dataType: string; nodeCount: number }): Promise<BetaRun> {
  return requestJson('/api/beta/runs', token, { method: 'POST', body: JSON.stringify(body) })
}

export function listSimulations(token: string) {
  return requestJson<{ simulations: BetaRun['simulation'][] }>('/api/beta/simulations', token)
}

export function listLogs(token: string) {
  return requestJson<{ logs: Array<BetaLogEvent & { logId: string; tokenRole: string; participantId?: string; roomId?: string }> }>('/api/beta/logs', token)
}

export function listAudit(token: string): Promise<{ events: AuditEvent[] }> {
  return requestJson('/api/beta/audit', token)
}

export function getLedger(token: string): Promise<BetaLedger> {
  return requestJson('/api/beta/ledger', token)
}
