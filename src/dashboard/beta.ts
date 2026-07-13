import { peerManager } from '../p2p/p2p-manager.js'

export type BetaResult = 'pass' | 'partial' | 'fail' | 'not_measured'
export type BetaRole = 'admin' | 'tester'

export interface BetaSessionPayload {
  name: string
  email?: string
  city?: string
  country?: string
  networkLabel?: string
  consentToCredit: boolean
  contributionNote?: string
}

export interface BetaEvidencePayload {
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

export interface BetaHookSource {
  __nodexPeerTelemetry?: () => Promise<unknown[]>
  __nodexStoragePressure?: () => Promise<unknown>
  __nodexRuntimeConfig?: () => unknown
  __nodexLifecycleSignals?: () => unknown[]
  __nodexDeviceHints?: () => unknown
}

export interface BetaLogEvent {
  time: string
  level: 'info' | 'warn' | 'error'
  message: string
  details?: unknown
}

interface StoredAuth {
  token: string
  role: BetaRole
  tokenPreview: string
  invite?: {
    label?: string
    assignedName?: string
    assignedEmail?: string
    welcomeNote?: string
    maxSessions?: number
  } | null
}

interface StoredBetaSession {
  participantId: string
  sessionToken: string
  roomId: string
  testUrl: string
}

interface BetaRun {
  runId: string
  roomId: string
  scenario: string
  dataType: string
  nodeCount: number
  testUrl?: string
  createdAt?: string
}

interface AdminToken {
  tokenId: string
  tokenPreview: string
  role: BetaRole
  label: string
  createdAt: string
  active: boolean
  revokedAt?: string | null
  expiresAt?: string | null
  useCount?: number
}

interface AuditEvent {
  eventId: string
  eventType: string
  severity: 'info' | 'warn' | 'error'
  actorRole?: BetaRole
  targetType?: string
  targetId?: string
  createdAt: string
}

interface BetaSimulation {
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

export type BetaMode = 'solo' | 'duo' | 'trio'
type SuitePage = 'setup' | 'profile' | 'room' | 'evidence' | 'admin'

interface TopologyNode {
  id: string
  name: string
  role: 'admin' | 'tester'
  online: boolean
  isMe: boolean
}

const PHASES = ['profile', 'session', 'simulation', 'evidence', 'sent'] as const
type PhaseId = typeof PHASES[number]

const AUTH_KEY = 'nodex-beta-auth-v2'
const SESSION_KEY = 'nodex-beta-session-v1'
const LOG_KEY = 'nodex-beta-log-events-v1'
const MODE_KEY = 'nodex-beta-mode-v1'
const PROFILE_KEY_PREFIX = 'nodex-beta-profile-v1'
const LOCAL_COORDINATOR_URL = 'http://localhost:3003'

// Mode requirements: how many admins and testers must be online
const MODE_REQUIREMENTS: Record<BetaMode, { admins: number; testers: number }> = {
  solo:  { admins: 0, testers: 0 },
  duo:   { admins: 1, testers: 0 },
  trio:  { admins: 1, testers: 1 },
}

let currentMode: BetaMode = 'solo'
let currentPage: SuitePage = 'setup'
let presenceInterval: ReturnType<typeof setInterval> | null = null
let heartbeatInterval: ReturnType<typeof setInterval> | null = null
let lastOnline: PresencePeer[] = []

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export function buildBetaSessionPayload(input: Partial<BetaSessionPayload>): BetaSessionPayload {
  const name = trimmed(input.name)
  if (!name) throw new Error('Participant name is required')
  if (input.consentToCredit !== true) throw new Error('Credit consent is required')

  return {
    name,
    email: trimmed(input.email),
    city: trimmed(input.city),
    country: trimmed(input.country),
    networkLabel: trimmed(input.networkLabel),
    consentToCredit: true,
    contributionNote: trimmed(input.contributionNote),
  }
}

export async function collectBetaEvidencePayload(input: {
  participantId: string
  roomId: string
  topologyLabel: string
  result: BetaResult
  notes?: string
  hooks: BetaHookSource
}): Promise<BetaEvidencePayload> {
  const telemetry = typeof input.hooks.__nodexPeerTelemetry === 'function'
    ? await input.hooks.__nodexPeerTelemetry()
    : []
  const storagePressure = typeof input.hooks.__nodexStoragePressure === 'function'
    ? await input.hooks.__nodexStoragePressure()
    : undefined
  const runtimeConfig = typeof input.hooks.__nodexRuntimeConfig === 'function'
    ? input.hooks.__nodexRuntimeConfig()
    : undefined
  const lifecycleSignals = typeof input.hooks.__nodexLifecycleSignals === 'function'
    ? input.hooks.__nodexLifecycleSignals()
    : []
  const deviceHints = typeof input.hooks.__nodexDeviceHints === 'function'
    ? input.hooks.__nodexDeviceHints()
    : collectDeviceHints()

  return {
    participantId: input.participantId,
    roomId: input.roomId,
    topologyLabel: input.topologyLabel,
    result: input.result,
    notes: trimmed(input.notes),
    telemetry,
    storagePressure,
    runtimeConfig,
    lifecycleSignals,
    deviceHints,
  }
}

export function buildLogBundle(events: BetaLogEvent[], session: StoredBetaSession | null): Record<string, unknown> {
  return {
    schema_version: 1,
    generatedAt: new Date().toISOString(),
    participantId: session?.participantId,
    roomId: session?.roomId,
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
    pageUrl: typeof location === 'undefined' ? undefined : location.href,
    events,
  }
}

function collectDeviceHints(): Record<string, unknown> {
  if (typeof navigator === 'undefined') return {}
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean; platform?: string; brands?: unknown[] } }).userAgentData
  return {
    userAgent: navigator.userAgent,
    platform: uaData?.platform ?? navigator.platform,
    brands: uaData?.brands,
    mobile: uaData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent),
    maxTouchPoints: navigator.maxTouchPoints,
    viewport: typeof window === 'undefined' ? undefined : { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
  }
}

function defaultCoordinatorUrl(): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env
  const configured = trimmed(env?.['VITE_NODEX_BETA_API_URL'])
  if (configured) return configured.replace(/\/$/, '')
  if (typeof window === 'undefined') return LOCAL_COORDINATOR_URL
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? LOCAL_COORDINATOR_URL
    : window.location.origin
}

function getInput(id: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const el = document.getElementById(id)
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    return el
  }
  throw new Error(`Missing input ${id}`)
}

function setText(id: string, value: string): void {
  const el = document.getElementById(id)
  if (el) el.textContent = value
}

function setFeedback(id: string, message: string, state: 'ok' | 'err' | '' = ''): void {
  const el = document.getElementById(id)
  if (!el) return
  el.textContent = message
  el.dataset['state'] = state
}

function addPhase(label: string): void {
  const events = readEvents()
  events.push({ time: new Date().toISOString(), level: 'info', message: `── ${label} ──`, details: { phase: true } })
  writeEvents(events)
  renderEvents()
}

function applyRoleAwareCopy(role: string): void {
  const duoTile = document.getElementById('btn-mode-duo')
  const trioTile = document.getElementById('btn-mode-trio')
  if (!duoTile || !trioTile) return

  if (role === 'admin') {
    duoTile.querySelector('strong')!.textContent = 'You + a tester'
    duoTile.querySelector('p')!.textContent = 'Two-node test. One tester joins as the second peer. Tests real P2P gossip and cache sharing between machines.'
    duoTile.querySelector('.mode-tag')!.textContent = 'Needs 1 tester'
    trioTile.querySelector('p')!.textContent = 'Full three-node network with both testers. Tests epidemic spread, multi-hop cache fetch, and geographic routing.'
    trioTile.querySelector('.mode-tag')!.textContent = 'Needs both testers'
  }
}

function showTopbarIdentity(name: string, role: string): void {
  const pill = document.getElementById('topbar-identity')
  const avatar = document.getElementById('topbar-avatar')
  const nameEl = document.getElementById('topbar-name')
  const roleEl = document.getElementById('topbar-role')
  if (pill) pill.classList.remove('hidden')
  if (avatar) avatar.textContent = name.charAt(0).toUpperCase()
  if (nameEl) nameEl.textContent = name
  if (roleEl) roleEl.textContent = role
}

function setHidden(selector: string, hidden: boolean): void {
  document.querySelectorAll<HTMLElement>(selector).forEach((el) => el.classList.toggle('hidden', hidden))
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

function readAuth(): StoredAuth | null {
  return readJson<StoredAuth>(AUTH_KEY)
}

function writeAuth(auth: StoredAuth): void {
  writeJson(AUTH_KEY, auth)
}

function readSession(): StoredBetaSession | null {
  return readJson<StoredBetaSession>(SESSION_KEY)
}

function writeSession(session: StoredBetaSession): void {
  writeJson(SESSION_KEY, session)
}

interface StoredProfile {
  name?: string
  email?: string
  city?: string
  country?: string
  networkLabel?: string
  consentToCredit?: boolean
}

function profileKey(auth = readAuth()): string | null {
  if (!auth) return null
  return `${PROFILE_KEY_PREFIX}:${auth.tokenPreview}`
}

function readProfile(): StoredProfile | null {
  const key = profileKey()
  return key ? readJson<StoredProfile>(key) : null
}

function writeProfile(profile: StoredProfile): void {
  const key = profileKey()
  if (key) writeJson(key, profile)
}

function saveProfileFromInputs(): void {
  writeProfile({
    name: trimmed(getInput('tester-name').value),
    email: trimmed(getInput('tester-email').value),
    city: trimmed(getInput('tester-city').value),
    country: trimmed(getInput('tester-country').value),
    networkLabel: trimmed(getInput('tester-network').value),
    consentToCredit: (getInput('tester-consent') as HTMLInputElement).checked,
  })
}

function applyStoredProfile(auth: StoredAuth): void {
  const profile = readProfile()
  const nameInput = document.getElementById('tester-name') as HTMLInputElement | null
  const emailInput = document.getElementById('tester-email') as HTMLInputElement | null
  const cityInput = document.getElementById('tester-city') as HTMLInputElement | null
  const countryInput = document.getElementById('tester-country') as HTMLInputElement | null
  const networkInput = document.getElementById('tester-network') as HTMLInputElement | null
  const consentInput = document.getElementById('tester-consent') as HTMLInputElement | null

  if (nameInput) nameInput.value = profile?.name ?? auth.invite?.assignedName ?? ''
  if (emailInput) emailInput.value = profile?.email ?? auth.invite?.assignedEmail ?? ''
  if (cityInput) cityInput.value = profile?.city ?? ''
  if (countryInput) countryInput.value = profile?.country ?? ''
  if (networkInput) networkInput.value = profile?.networkLabel ?? ''
  if (consentInput) consentInput.checked = profile?.consentToCredit === true

  const noteInput = document.getElementById('contribution-note') as HTMLTextAreaElement | null
  if (noteInput) noteInput.value = ''
}

function readEvents(): BetaLogEvent[] {
  return readJson<BetaLogEvent[]>(LOG_KEY) ?? []
}

function writeEvents(events: BetaLogEvent[]): void {
  writeJson(LOG_KEY, events.slice(-80))
}

function currentCoordinatorUrl(): string {
  return trimmed((getInput('coordinator-url') as HTMLInputElement).value) ?? defaultCoordinatorUrl()
}

async function requestJson<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json')
  headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`${currentCoordinatorUrl()}${path}`, { ...init, headers })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return await response.json() as T
}

function addEvent(message: string, details?: unknown, level: BetaLogEvent['level'] = 'info'): void {
  const events = readEvents()
  events.push({ time: new Date().toISOString(), level, message, details })
  writeEvents(events)
  renderEvents()
}

function renderEvents(): void {
  const events = readEvents()
  const list = document.getElementById('local-log-stream')
  const output = document.getElementById('log-output') as HTMLTextAreaElement | null
  if (list) {
    list.innerHTML = ''
    events.slice(-10).forEach((event) => {
      const item = document.createElement('li')
      const isPhase = (event.details as Record<string, unknown> | undefined)?.['phase'] === true
      if (isPhase) {
        item.textContent = event.message
        item.classList.add('phase-marker')
      } else {
        const t = new Date(event.time).toLocaleTimeString()
        item.textContent = `${t} — ${event.message}`
      }
      list.appendChild(item)
    })
  }
  if (output) output.value = JSON.stringify(buildLogBundle(events, readSession()), null, 2)
  setText('log-count', `${events.length} event${events.length === 1 ? '' : 's'}`)
}

function showSession(session: StoredBetaSession): void {
  setText('participant-id', session.participantId)
  setText('room-id', session.roomId)
  setText('session-state', 'ready')
  const link = document.getElementById('test-url') as HTMLAnchorElement | null
  const openLink = document.getElementById('open-test-url') as HTMLAnchorElement | null
  if (link) {
    link.href = session.testUrl
    link.textContent = session.testUrl
  }
  if (openLink) openLink.href = session.testUrl
}

function showSuitePage(page: SuitePage, opts: { scroll?: boolean } = {}): void {
  const auth = readAuth()
  if (page === 'admin' && auth?.role !== 'admin') page = 'setup'
  const testSteps = document.getElementById('test-steps')
  const needsSteps = page === 'profile' || page === 'room' || page === 'evidence'
  if (needsSteps && testSteps?.classList.contains('hidden')) page = 'setup'

  currentPage = page
  document.querySelectorAll<HTMLElement>('[data-suite-page]').forEach((section) => {
    section.classList.toggle('active-page', section.dataset['suitePage'] === page)
  })
  document.querySelectorAll<HTMLAnchorElement>('[data-suite-link]').forEach((link) => {
    link.classList.toggle('active', link.dataset['suiteLink'] === page)
  })

  const target = needsSteps
    ? document.getElementById('test-steps')
    : document.querySelector<HTMLElement>(`[data-suite-page="${page}"]`)
  if (opts.scroll !== false) {
    window.scrollTo({ top: Math.max((target?.offsetTop ?? 0) - 110, 0), left: 0 })
  }
}

function configureWorkspaceCopy(auth: StoredAuth): void {
  const title = document.getElementById('workspace-title')
  const copy = document.getElementById('workspace-copy')
  if (!title || !copy) return

  if (auth.role === 'admin') {
    title.textContent = 'Admin control room.'
    copy.textContent = 'Create personal invites, coordinate beta runs, and watch evidence arrive without exposing internal tools to testers.'
    return
  }

  title.innerHTML = '<span id="tester-name-greeting">Your</span> Nodex beta workspace.'
  copy.textContent = 'Follow one page at a time. Your basic test details stay saved in this browser, while your contribution note remains fresh for each run.'
}

function showAuthedApp(auth: StoredAuth): void {
  setHidden('#login-screen', true)
  setHidden('#suite-app', false)
  setHidden('#topbar-nav', false)
  setHidden('#logout-button', false)
  setHidden('.admin-only', auth.role !== 'admin')
  window.scrollTo({ top: 0, left: 0 })
  setText('token-role', auth.role)
  setText('token-preview', auth.tokenPreview)
  configureWorkspaceCopy(auth)

  const displayName = auth.invite?.assignedName ?? (auth.role === 'admin' ? 'Admin' : 'Tester')
  showTopbarIdentity(displayName, auth.role)
  applyRoleAwareCopy(auth.role)

  if (auth.invite?.assignedName) {
    const name = auth.invite.assignedName.trim()
    const possessive = name.endsWith('s') ? `${name}'` : `${name}'s`
    setText('tester-name-greeting', possessive)
  }
  if (auth.invite?.welcomeNote) setText('invite-welcome-note', auth.invite.welcomeNote)
  applyStoredProfile(auth)

  const savedMode = localStorage.getItem(MODE_KEY) as BetaMode | null
  const existing = readSession()
  let landingPage: SuitePage = auth.role === 'admin' ? 'admin' : 'setup'
  if (existing && savedMode) {
    // Returning session — skip mode selector, go straight to steps
    currentMode = savedMode
    setHidden('#mode-select', true)
    setHidden('#test-steps', false)
    showSession(existing)
    landingPage = auth.role === 'admin' ? 'admin' : 'profile'
  } else {
    setHidden('#mode-select', false)
    setHidden('#test-steps', true)
  }
  setHidden('#conn-panel', true)

  renderEvents()
  if (auth.role === 'admin') void refreshAdmin()
  showSuitePage(landingPage, { scroll: false })

  // Keep presence alive so peers can see this user
  if (heartbeatInterval) clearInterval(heartbeatInterval)
  void postPresence(currentMode)
  heartbeatInterval = setInterval(() => { void postPresence(currentMode) }, 15_000)
}

interface PresencePeer {
  name: string
  role: string
  mode: string
  lastSeen: string
}

function selectMode(mode: BetaMode): void {
  currentMode = mode
  localStorage.setItem(MODE_KEY, mode)

  document.querySelectorAll<HTMLButtonElement>('.mode-tile').forEach((tile) => {
    tile.classList.toggle('active', tile.dataset['mode'] === mode)
  })

  addPhase(`Test mode: ${mode.toUpperCase()}`)
  addEvent(`Selected test mode: ${mode}.`, { mode, requirements: MODE_REQUIREMENTS[mode] })

  const req = MODE_REQUIREMENTS[mode]
  const needsConnectivity = req.admins > 0 || req.testers > 0

  // Update run step copy based on mode
  const modeLabels: Record<BetaMode, { title: string; desc: string }> = {
    solo: {
      title: 'Run the solo simulation.',
      desc: 'Simulates cache hits, SW interception, and epidemic spread from a single browser node.',
    },
    duo: {
      title: 'Run the two-node simulation.',
      desc: 'You and Davi act as two connected nodes. Tests real P2P gossip, cache sharing, and invalidation between two machines.',
    },
    trio: {
      title: 'Run the full three-node simulation.',
      desc: 'All three nodes active. Tests epidemic spread, multi-hop cache fetch, and geographic routing across three separate browsers.',
    },
  }
  const label = modeLabels[mode]
  setText('run-title-heading', label.title)
  setText('run-desc', label.desc)

  // Pre-select topology based on mode
  const topologySelect = document.getElementById('topology-label') as HTMLSelectElement | null
  if (topologySelect) {
    topologySelect.value = mode === 'solo' ? 'background-tab'
      : mode === 'duo' ? 'lan-multi-machine'
      : 'wan-nat'
  }

  if (needsConnectivity) {
    setHidden('#mode-select', true)
    setHidden('#conn-panel', false)
    setHidden('#test-steps', true)
    addPhase('Connectivity check')
    void startConnectivityCheck(mode)
  } else {
    setHidden('#mode-select', true)
    setHidden('#conn-panel', true)
    setHidden('#test-steps', false)
    addPhase('Solo test')
    setPhase('profile')
    addSimpleLog('Solo test ready — fill in your profile below.', 'phase')
    showSuitePage('profile')
  }
}

async function fetchPresence(): Promise<PresencePeer[]> {
  const auth = readAuth()
  if (!auth) return []
  try {
    const res = await requestJson<{ online: PresencePeer[] }>('/api/beta/presence', auth.token)
    return res.online
  } catch {
    return []
  }
}

async function postPresence(mode: BetaMode): Promise<PresencePeer[]> {
  const auth = readAuth()
  if (!auth) return []
  const session = readSession()
  const name = auth.invite?.assignedName ?? (auth.role === 'admin' ? 'Admin' : 'Tester')
  try {
    const res = await requestJson<{ online: PresencePeer[] }>('/api/beta/presence', auth.token, {
      method: 'POST',
      body: JSON.stringify({ name, mode, participantId: session?.participantId }),
    })
    return res.online
  } catch {
    return []
  }
}

function canStart(mode: BetaMode, online: PresencePeer[]): boolean {
  const { admins, testers } = MODE_REQUIREMENTS[mode]
  const auth = readAuth()
  const myTokenPreview = auth?.tokenPreview ?? ''
  const others = online.filter((p) => !myTokenPreview || !p.name.startsWith(auth?.invite?.assignedName?.charAt(0) ?? '____'))
  const adminCount = online.filter((p) => p.role === 'admin').length
  const testerCount = online.filter((p) => p.role === 'tester').length
  return adminCount >= admins && testerCount >= testers
}

function renderPresenceList(online: PresencePeer[], mode: BetaMode): void {
  lastOnline = online
  renderTopology('topology-canvas', online, mode)
  const list = document.getElementById('peer-list')
  const btn = document.getElementById('btn-start-connected') as HTMLButtonElement | null
  if (!list) return

  const auth = readAuth()
  const myName = auth?.invite?.assignedName ?? (auth?.role === 'admin' ? 'Admin' : 'Tester')

  // Define expected participants per mode
  const expected: Array<{ name: string; role: 'admin' | 'tester' }> =
    mode === 'duo'
      ? [{ name: myName, role: auth?.role as 'admin' | 'tester' }, { name: 'Davi', role: 'admin' }]
      : [{ name: myName, role: auth?.role as 'admin' | 'tester' }, { name: 'Davi', role: 'admin' }, { name: 'the other tester', role: 'tester' }]

  list.innerHTML = ''
  for (const exp of expected) {
    const found = online.find((p) => p.name.toLowerCase() === exp.name.toLowerCase() || (exp.name === 'the other tester' && p.role === 'tester' && p.name.toLowerCase() !== myName.toLowerCase()))
    const isMe = exp.name.toLowerCase() === myName.toLowerCase()
    const item = document.createElement('li')
    item.className = `peer-item ${found ? 'online' : 'offline'}`

    const nameSpan = document.createElement('span')
    nameSpan.className = 'peer-name'
    nameSpan.textContent = isMe ? `${exp.name} (you)` : exp.name

    const roleSpan = document.createElement('span')
    roleSpan.className = 'peer-role'
    roleSpan.textContent = exp.role

    const statusSpan = document.createElement('span')
    statusSpan.className = 'peer-since'
    statusSpan.textContent = found ? 'online' : 'waiting...'

    item.append(nameSpan, roleSpan, statusSpan)
    list.appendChild(item)
  }

  const ready = canStart(mode, online)
  if (btn) {
    btn.disabled = !ready
    btn.textContent = ready ? 'Everyone is ready — Start test' : 'Waiting for peers...'
  }
  setFeedback('conn-status', ready ? 'All participants online. You can start the test.' : 'Waiting for all participants to open the app.', ready ? 'ok' : '')
}

async function startConnectivityCheck(mode: BetaMode): Promise<void> {
  addEvent(`Sending presence ping for ${mode} mode...`, { mode })
  const online = await postPresence(mode)
  renderPresenceList(online, mode)

  if (presenceInterval) clearInterval(presenceInterval)
  presenceInterval = setInterval(() => {
    void postPresence(mode).then((peers) => {
      renderPresenceList(peers, mode)
      addEvent(`Presence refresh — ${peers.length} online.`, { peers: peers.map((p) => p.name) })
    })
  }, 8_000)
}

function renderSimulation(simulation: BetaSimulation | null): void {
  if (!simulation) return
  setText('sim-hit-rate', `${simulation.metrics.hitRatePct}%`)
  setText('sim-p95', `${simulation.metrics.p95LatencyMs}ms`)
  setText('sim-origin-saved', `${simulation.metrics.estimatedOriginReadsAvoided}`)
  setText('sim-reach', `${simulation.metrics.invalidationReachPct}%`)

  const list = document.getElementById('simulation-event-list')
  if (!list) return
  list.innerHTML = ''
  simulation.events.slice(0, 8).forEach((event) => {
    const item = document.createElement('li')
    item.textContent = `${event.nodeId} ${event.source} ${event.latencyMs}ms ${event.key}`
    list.appendChild(item)
  })
}

async function initPeerLayer(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  await navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined)
  await navigator.serviceWorker.ready
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })
    })
  }
  await peerManager.init()
}

async function refreshAdmin(): Promise<void> {
  const auth = readAuth()
  if (!auth || auth.role !== 'admin') return
  const [tokens, runs, logs, simulations, audit] = await Promise.all([
    requestJson<{ createdTokens: AdminToken[] }>('/api/beta/tokens', auth.token),
    requestJson<{ runs: BetaRun[] }>('/api/beta/runs', auth.token),
    requestJson<{ logs: Array<{ createdAt: string; level: string; message: string; tokenRole: string }> }>('/api/beta/logs', auth.token),
    requestJson<{ simulations: BetaSimulation[] }>('/api/beta/simulations', auth.token),
    requestJson<{ events: AuditEvent[] }>('/api/beta/audit', auth.token).catch(() => ({ events: [] })),
  ])

  const tokenList = document.getElementById('token-list')
  if (tokenList) {
    tokenList.innerHTML = ''
    tokens.createdTokens.slice(-6).forEach((token) => {
      const item = document.createElement('li')
      const revoked = !token.active || Boolean(token.revokedAt)
      const expired = token.expiresAt ? new Date(token.expiresAt).getTime() <= Date.now() : false
      const status = revoked ? 'revoked' : expired ? 'expired' : 'active'
      item.className = `admin-token-row token-${status}`
      const label = document.createElement('span')
      label.textContent = `${token.label} - ${token.role} - ${token.tokenPreview} - ${status} - uses:${token.useCount ?? 0}`
      item.appendChild(label)
      if (!revoked) {
        const revoke = document.createElement('button')
        revoke.type = 'button'
        revoke.className = 'mini-danger-button'
        revoke.textContent = 'Revoke'
        revoke.addEventListener('click', () => { void revokeToken(token.tokenId) })
        item.appendChild(revoke)
      }
      tokenList.appendChild(item)
    })
  }

  const runList = document.getElementById('run-list')
  if (runList) {
    runList.innerHTML = ''
    runs.runs.slice(-6).forEach((run) => {
      const item = document.createElement('li')
      item.textContent = `${run.scenario} - ${run.dataType} - ${run.nodeCount} nodes`
      runList.appendChild(item)
    })
  }

  const remoteLogList = document.getElementById('remote-log-list')
  if (remoteLogList) {
    remoteLogList.innerHTML = ''
    logs.logs.slice(-6).forEach((log) => {
      const item = document.createElement('li')
      item.textContent = `${log.tokenRole}/${log.level}: ${log.message}`
      remoteLogList.appendChild(item)
    })
  }

  const auditList = document.getElementById('audit-list')
  if (auditList) {
    auditList.innerHTML = ''
    audit.events.slice(-8).reverse().forEach((event) => {
      const item = document.createElement('li')
      item.textContent = `${event.severity}/${event.eventType} - ${event.targetType ?? 'system'}:${event.targetId ?? '-'}`
      auditList.appendChild(item)
    })
  }

  renderSimulation(simulations.simulations.at(-1) ?? null)
}

async function revokeToken(tokenId: string): Promise<void> {
  const auth = readAuth()
  if (!auth || auth.role !== 'admin') return
  setFeedback('token-status', 'Revoking token...')
  try {
    await requestJson(`/api/beta/tokens/${encodeURIComponent(tokenId)}/revoke`, auth.token, { method: 'POST' })
    setFeedback('token-status', 'Token revoked immediately.', 'ok')
    await refreshAdmin()
  } catch (err) {
    setFeedback('token-status', `Revoke failed: ${(err as Error).message}`, 'err')
  }
}

function updateInterceptorPanel(capture: { key: string; seq: number; ivB64?: string; ctSample?: string; ts: number }): void {
  const panel = document.getElementById('interceptor-panel')
  if (panel) panel.classList.remove('hidden')
  setText('interceptor-key', capture.key)
  setText('interceptor-seq', String(capture.seq))
  setText('interceptor-iv', capture.ivB64 ?? 'n/a')
  setText('interceptor-ct', capture.ctSample ? `${capture.ctSample}…` : 'n/a')
  setText('interceptor-ts', new Date(capture.ts).toLocaleTimeString())
}

async function pollAdminInterceptorCaptures(): Promise<void> {
  const auth = readAuth()
  if (!auth || auth.role !== 'admin') return
  try {
    const res = await requestJson<{ captures: Array<{ path: string; seq: number; iv_b64: string; ciphertext_sample_b64: string; timestamp: string }> }>('/api/beta/interceptor', auth.token)
    const list = document.getElementById('interceptor-server-list')
    if (!list) return
    list.innerHTML = ''
    res.captures.slice(-8).reverse().forEach((c) => {
      const item = document.createElement('div')
      item.className = 'interceptor-capture'
      item.innerHTML = `<span class="ic-path">${c.path}</span><span class="ic-seq">seq ${c.seq}</span><span class="ic-iv" title="IV">${c.iv_b64.slice(0, 10)}…</span><span class="ic-ct">${c.ciphertext_sample_b64.slice(0, 20)}…</span><span class="ic-ts">${new Date(c.timestamp).toLocaleTimeString()}</span>`
      list.appendChild(item)
    })
  } catch { /* server captures unavailable */ }
}

async function runRealTest(): Promise<void> {
  const session = readSession()
  const mode = currentMode
  const nodeCount = mode === 'solo' ? 1 : mode === 'duo' ? 2 : 3
  const PRODUCT_IDS = [1, 2, 3, 4, 5]
  const REQUEST_COUNT = mode === 'solo' ? 3 : mode === 'duo' ? 5 : 8

  addPhase(`Real test — ${mode} / ${nodeCount} node${nodeCount > 1 ? 's' : ''}`)
  setPhase('simulation')
  showSuitePage('room')
  document.getElementById('room')?.classList.add('running-focus')
  addSimpleLog(`Starting real ${mode} test — Service Worker + encrypted API…`, 'phase')
  addEvent('Starting real test.', { mode, nodeCount, roomId: session?.roomId, swReady: !!navigator.serviceWorker?.controller })

  const metricsCollected: Array<{ type: string; key: string; latency_ms?: number }> = []
  let metricsChannel: BroadcastChannel | null = null
  if (typeof BroadcastChannel !== 'undefined') {
    metricsChannel = new BroadcastChannel('nodex-metrics')
    metricsChannel.onmessage = (e: MessageEvent) => {
      metricsCollected.push(e.data as typeof metricsCollected[0])
    }
  }

  // Seed SW cache via real API fetch (SW will intercept and store ciphertext)
  addSimpleLog('Fetching /api/products/1 to seed SW cache…', 'info')
  try {
    const res = await fetch('/api/products/1', { cache: 'no-store' })
    if (res.ok) {
      const seq = res.headers.get('X-Nodex-Seq')
      const iv = res.headers.get('X-Nodex-Iv')
      addEvent('SW cache seeded with encrypted payload.', { status: res.status, seq })
      addSimpleLog(`Encrypted payload received from server — seq=${seq}, iv=${iv?.slice(0, 8)}…`, 'ok')
    }
  } catch (err) {
    addEvent('Seed fetch error.', { error: (err as Error).message }, 'warn')
    addSimpleLog('Server unreachable — SW will serve from cache if available.', 'warn')
  }

  // Main request loop — SW intercepts these and serves from cache, peer, or origin
  const fetchResults: Array<{ key: string; latencyMs: number; seq: string | null }> = []
  for (let i = 0; i < REQUEST_COUNT; i++) {
    const id = PRODUCT_IDS[i % PRODUCT_IDS.length]!
    const key = `/api/products/${id}`
    const t0 = performance.now()
    try {
      const res = await fetch(key)
      const latencyMs = Math.round(performance.now() - t0)
      const seq = res.headers.get('X-Nodex-Seq')
      fetchResults.push({ key, latencyMs, seq })
      addEvent(`Fetch ${i + 1}: ${key} — ${latencyMs}ms seq=${seq ?? '?'}`, { latencyMs, seq })
    } catch (err) {
      addEvent(`Fetch ${i + 1}: ${key} — error`, { error: (err as Error).message }, 'warn')
    }
    await new Promise<void>((r) => setTimeout(r, 80))
  }
  // Allow BroadcastChannel events to arrive
  await new Promise<void>((r) => setTimeout(r, 250))
  metricsChannel?.close()

  const swCacheHits = metricsCollected.filter((m) => m.type === 'sw-cache').length
  const peerHits = metricsCollected.filter((m) => m.type === 'peer-fetch').length
  const serverFallbacks = metricsCollected.filter((m) => m.type === 'server-fallback').length
  const total = metricsCollected.length || fetchResults.length
  const hitRatePct = total > 0 ? Math.round(((swCacheHits + peerHits) / total) * 100) : 0

  addSimpleLog(`${fetchResults.length} requests — SW: ${swCacheHits}, P2P: ${peerHits}, server: ${serverFallbacks || 'via SW'}`, 'ok')

  // Trigger server-side cache invalidation → gossip epidemic
  addSimpleLog('Triggering gossip invalidation via /api/invalidate/products/1…', 'info')
  try {
    const invRes = await fetch('/api/invalidate/products/1', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    })
    if (invRes.ok) {
      const data = await invRes.json() as { seq: number }
      addEvent('Invalidation seeded.', { seq: data.seq })
      addSimpleLog(`Invalidation seeded — new seq=${data.seq}. Gossip propagating to peers…`, 'ok')
      await new Promise<void>((r) => setTimeout(r, 600))
    }
  } catch (err) {
    addEvent('Invalidation seed error.', { error: (err as Error).message }, 'warn')
    addSimpleLog('Invalidation endpoint unreachable — gossip won\'t trigger automatically.', 'warn')
  }

  // Surface interceptor capture if a P2P transfer happened
  const captureGetter = (window as unknown as Record<string, () => unknown>)['__nodexLastP2PCapture']
  if (typeof captureGetter === 'function') {
    const c = captureGetter() as { key: string; seq: number; ivB64?: string; ctSample?: string; ts: number } | null
    if (c) {
      addSimpleLog(`P2P payload intercepted: ${c.key} seq=${c.seq} iv=${c.ivB64?.slice(0, 8)}…`, 'info')
      updateInterceptorPanel(c)
    }
  }

  // Admin: pull server-side capture log
  void pollAdminInterceptorCaptures()

  addEvent('Real test complete.', { swCacheHits, peerHits, serverFallbacks, hitRatePct })
  addPhase('Test complete')
  addSimpleLog(`Test complete — cache hit rate: ${hitRatePct}%. Save your result in Step 3.`, 'phase')
  setFeedback('log-status', 'Real test complete. Review the logs and save your result in Step 3.', 'ok')
  document.getElementById('room')?.classList.remove('running-focus')
  document.getElementById('logs')?.classList.add('running-focus')
  showSuitePage('evidence')
}

async function autoSendLogs(): Promise<void> {
  const auth = readAuth()
  if (!auth) return
  const session = readSession()
  const events = readEvents()
  const bundle = buildLogBundle(events, session)

  addEvent('Auto-sending full log bundle to admin panel...', { eventCount: events.length })

  try {
    const result = await requestJson<{ logId: string }>('/api/beta/logs', auth.token, {
      method: 'POST',
      body: JSON.stringify({
        participantId: session?.participantId,
        roomId: session?.roomId,
        level: 'info',
        message: `Log bundle from ${auth.invite?.assignedName ?? 'tester'} — mode:${currentMode} events:${events.length}`,
        details: bundle,
      }),
    })
    addEvent('Logs sent successfully.', { logId: result.logId })
    setPhase('sent')
    addSimpleLog('All done! Your logs were sent successfully.', 'ok')
    setFeedback('log-status', 'All done. Your logs have been sent to the admin panel.', 'ok')
    if (auth.role === 'admin') void refreshAdmin()
  } catch (err) {
    addEvent('Auto-send failed — use the Send Logs button to retry.', { error: (err as Error).message }, 'warn')
    setFeedback('log-status', 'Auto-send failed. Use the Send Logs button to retry.', 'err')
  }
}

function downloadLogBundle(): void {
  const blob = new Blob([JSON.stringify(buildLogBundle(readEvents(), readSession()), null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `nodex-beta-logs-${Date.now()}.json`
  link.click()
  URL.revokeObjectURL(url)
  setText('log-status', 'Log file downloaded.')
}

function getNodePositions(count: number, W: number, H: number): Array<{ x: number; y: number }> {
  if (count === 1) return [{ x: W / 2, y: H / 2 }]
  if (count === 2) return [{ x: W * 0.27, y: H / 2 }, { x: W * 0.73, y: H / 2 }]
  return [
    { x: W / 2, y: H * 0.27 },
    { x: W * 0.27, y: H * 0.73 },
    { x: W * 0.73, y: H * 0.73 },
  ]
}

function buildTopologySVG(nodes: TopologyNode[]): string {
  const W = 560
  const H = nodes.length <= 2 ? 170 : 220
  const positions = getNodePositions(nodes.length, W, H)

  const lines = nodes.flatMap((a, i) =>
    nodes.slice(i + 1).map((b, j) => {
      const pa = positions[i]!
      const pb = positions[i + 1 + j]!
      const active = a.online && b.online
      return `<line x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}" class="conn-line ${active ? 'active' : 'waiting'}" />`
    })
  )

  const nodeEls = nodes.map((node, i) => {
    const p = positions[i]!
    const stateClass = node.online ? 'online' : 'offline'
    const label = node.isMe ? `${node.name} (you)` : node.name
    return `<g class="topo-node ${stateClass}" transform="translate(${p.x},${p.y})">
      <rect x="-22" y="-20" width="44" height="30" rx="5" class="mon-body"/>
      <rect x="-18" y="-16" width="36" height="22" rx="3" class="mon-screen"/>
      <rect x="-4" y="10" width="8" height="5" class="mon-neck"/>
      <rect x="-13" y="15" width="26" height="4" rx="2" class="mon-base"/>
      <circle cx="18" cy="-18" r="4" class="status-dot ${stateClass}"/>
      <text x="0" y="38" class="node-name">${label}</text>
      <text x="0" y="52" class="node-role-label">${node.role}</text>
    </g>`
  })

  return `<svg class="topo-svg" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <g class="conn-lines">${lines.join('')}</g>
    <g class="nodes">${nodeEls.join('')}</g>
  </svg>`
}

function buildTopologyNodes(online: PresencePeer[], mode: BetaMode): TopologyNode[] {
  const auth = readAuth()
  const myName = auth?.invite?.assignedName ?? (auth?.role === 'admin' ? 'Admin' : 'Tester')
  const myRole = (auth?.role ?? 'tester') as 'admin' | 'tester'

  if (mode === 'solo') {
    return [{ id: 'me', name: myName, role: myRole, online: true, isMe: true }]
  }
  const adminOnline = online.some((p) => p.role === 'admin' && p.name.toLowerCase() !== myName.toLowerCase())
  const nodes: TopologyNode[] = [
    { id: 'me', name: myName, role: myRole, online: true, isMe: true },
    { id: 'admin', name: 'Davi', role: 'admin', online: adminOnline, isMe: false },
  ]
  if (mode === 'trio') {
    const testerOnline = online.some((p) => p.role === 'tester' && p.name.toLowerCase() !== myName.toLowerCase())
    const testerPeer = online.find((p) => p.role === 'tester' && p.name.toLowerCase() !== myName.toLowerCase())
    nodes.push({ id: 'tester2', name: testerPeer?.name ?? 'Tester', role: 'tester', online: testerOnline, isMe: false })
  }
  return nodes
}

function renderTopology(containerId: string, online: PresencePeer[], mode: BetaMode): void {
  const container = document.getElementById(containerId)
  if (!container) return
  const nodes = buildTopologyNodes(online, mode)
  container.innerHTML = buildTopologySVG(nodes)
}

function setPhase(phaseId: PhaseId): void {
  const phaseIndex = PHASES.indexOf(phaseId)
  document.querySelectorAll<HTMLElement>('.phase-step').forEach((step) => {
    const phase = step.dataset['phase'] as PhaseId
    const idx = PHASES.indexOf(phase)
    const icon = step.querySelector('.phase-icon')
    if (idx < phaseIndex) {
      step.dataset['status'] = 'done'
      if (icon) icon.textContent = '✓'
    } else if (idx === phaseIndex) {
      step.dataset['status'] = 'active'
      if (icon) icon.textContent = '●'
    } else {
      step.dataset['status'] = 'pending'
      if (icon) icon.textContent = String(idx + 1)
    }
  })
  document.querySelectorAll<HTMLElement>('.phase-track').forEach((track, i) => {
    track.classList.toggle('active', i < phaseIndex)
  })
}

function addSimpleLog(message: string, type: 'info' | 'ok' | 'warn' | 'phase' = 'info'): void {
  const container = document.getElementById('simple-log')
  if (!container) return
  const icons: Record<string, string> = { info: 'ℹ', ok: '✓', warn: '⚠', phase: '▶' }
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const entry = document.createElement('div')
  entry.className = 'slog-entry'
  entry.dataset['type'] = type
  const icon = document.createElement('span')
  icon.className = 'slog-icon'
  icon.textContent = icons[type] ?? 'ℹ'
  const text = document.createElement('span')
  text.className = 'slog-text'
  text.textContent = message
  const time = document.createElement('span')
  time.className = 'slog-time'
  time.textContent = t
  entry.append(icon, text, time)
  container.appendChild(entry)
  container.scrollTop = container.scrollHeight
}

if (typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    const coordinatorInput = getInput('coordinator-url') as HTMLInputElement
    if (!trimmed(coordinatorInput.value)) coordinatorInput.value = defaultCoordinatorUrl()

    const auth = readAuth()
    if (auth) showAuthedApp(auth)

    void initPeerLayer().catch(() => {
      addEvent('Service Worker or peer layer is not ready yet.', undefined, 'warn')
    })

    document.getElementById('logout-button')?.addEventListener('click', () => {
      localStorage.removeItem(AUTH_KEY)
      localStorage.removeItem(MODE_KEY)
      if (presenceInterval) clearInterval(presenceInterval)
      if (heartbeatInterval) clearInterval(heartbeatInterval)
      location.reload()
    })

    document.querySelectorAll<HTMLAnchorElement>('[data-suite-link]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault()
        const page = link.dataset['suiteLink'] as SuitePage | undefined
        if (page) showSuitePage(page)
      })
    })

    ;['tester-name', 'tester-email', 'tester-city', 'tester-country', 'tester-network', 'tester-consent'].forEach((id) => {
      document.getElementById(id)?.addEventListener('input', saveProfileFromInputs)
      document.getElementById(id)?.addEventListener('change', saveProfileFromInputs)
    })

    // Mode tiles
    document.querySelectorAll<HTMLButtonElement>('.mode-tile').forEach((tile) => {
      tile.addEventListener('click', () => {
        const mode = tile.dataset['mode'] as BetaMode | undefined
        if (mode) selectMode(mode)
      })
    })

    // Connectivity panel buttons
    document.getElementById('btn-refresh-presence')?.addEventListener('click', () => {
      addEvent('Manual presence refresh.', { mode: currentMode })
      void postPresence(currentMode).then((peers) => renderPresenceList(peers, currentMode))
    })

    document.getElementById('btn-start-connected')?.addEventListener('click', () => {
      if (presenceInterval) { clearInterval(presenceInterval); presenceInterval = null }
      setHidden('#conn-panel', true)
      setHidden('#test-steps', false)
      const topoBar = document.getElementById('topo-bar')
      if (topoBar) {
        topoBar.classList.remove('hidden')
        renderTopology('topo-bar-canvas', lastOnline, currentMode)
      }
      setPhase('profile')
      addSimpleLog(`${currentMode === 'duo' ? 'Two' : 'Three'}-node network ready — fill in your profile below.`, 'phase')
      addPhase(`${currentMode === 'duo' ? 'Two-node' : 'Three-node'} test`)
      addEvent('All peers confirmed. Starting multi-person test.', { mode: currentMode })
      showSuitePage('profile')
    })

    document.getElementById('btn-back-mode')?.addEventListener('click', () => {
      if (presenceInterval) { clearInterval(presenceInterval); presenceInterval = null }
      setHidden('#conn-panel', true)
      setHidden('#test-steps', true)
      setHidden('#mode-select', false)
    })

    document.getElementById('beta-login-form')?.addEventListener('submit', (event) => {
      event.preventDefault()
      const token = trimmed((getInput('invite-token') as HTMLInputElement).value)
      if (!token) {
        setText('login-status', 'Paste your beta token to continue.')
        return
      }
      setFeedback('login-status', 'Checking token...')
      void requestJson<{ role: BetaRole; tokenPreview: string; invite?: StoredAuth['invite'] }>('/api/beta/auth', token, { method: 'POST' })
        .then((result) => {
          const authRecord = { token, role: result.role, tokenPreview: result.tokenPreview, invite: result.invite }
          writeAuth(authRecord)
          addEvent(`Signed in as ${result.role}.`)
          showAuthedApp(authRecord)
        })
        .catch(() => setFeedback('login-status', 'That token was not accepted. Check the invite and try again.', 'err'))
    })

    document.getElementById('beta-session-form')?.addEventListener('submit', (event) => {
      event.preventDefault()
      const auth = readAuth()
      if (!auth) return

      let payload: BetaSessionPayload
      try {
        payload = buildBetaSessionPayload({
          name: getInput('tester-name').value,
          email: getInput('tester-email').value,
          city: getInput('tester-city').value,
          country: getInput('tester-country').value,
          networkLabel: getInput('tester-network').value,
          consentToCredit: (getInput('tester-consent') as HTMLInputElement).checked,
          contributionNote: getInput('contribution-note').value,
        })
      } catch (err) {
        setText('beta-status', (err as Error).message)
        return
      }
      saveProfileFromInputs()

      setFeedback('beta-status', 'Creating your test room...')
      void requestJson<StoredBetaSession>('/api/beta/sessions', auth.token, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
        .then((session) => {
          writeSession(session)
          showSession(session)
          addEvent('Created participant session.', { participantId: session.participantId, roomId: session.roomId })
          setPhase('session')
          addSimpleLog('Profile saved — move to Step 2 to run the test.', 'ok')
          setFeedback('beta-status', 'Your session is ready.', 'ok')
        })
        .catch((err) => setFeedback('beta-status', `Session failed: ${(err as Error).message}`, 'err'))
    })

    document.getElementById('run-local-simulation')?.addEventListener('click', () => {
      void runRealTest()
    })
    document.getElementById('open-test-url')?.addEventListener('click', (event) => {
      event.preventDefault()
      const session = readSession()
      if (!session) {
        setFeedback('room-status', 'Create your session first. Then this button opens the test room.', 'err')
        showSuitePage('profile')
        return
      }
      document.querySelector('.assignment-card')?.classList.add('room-opened')
      setFeedback('room-status', 'Test room opened. Continue with Run Guided Test.', 'ok')
      addSimpleLog('Test room opened — ready to run the guided test.', 'phase')
      showSuitePage('room')
    })
    document.getElementById('btn-poll-interceptor')?.addEventListener('click', () => {
      void pollAdminInterceptorCaptures()
    })
    document.getElementById('download-log-bundle')?.addEventListener('click', downloadLogBundle)
    document.getElementById('copy-log-bundle')?.addEventListener('click', () => {
      const bundle = JSON.stringify(buildLogBundle(readEvents(), readSession()), null, 2)
      void navigator.clipboard?.writeText(bundle)
      setText('log-status', 'Logs copied. If clipboard access is blocked, use Download Logs.')
    })
    document.getElementById('send-log-bundle')?.addEventListener('click', () => {
      setFeedback('log-status', 'Sending logs...')
      void autoSendLogs()
    })

    document.getElementById('evidence-form')?.addEventListener('submit', (event) => {
      event.preventDefault()
      const session = readSession()
      if (!session) {
        setText('evidence-status', 'Create a beta session first.')
        return
      }

      setFeedback('evidence-status', 'Collecting evidence...')
      void collectBetaEvidencePayload({
        participantId: session.participantId,
        roomId: session.roomId,
        topologyLabel: getInput('topology-label').value,
        result: getInput('evidence-result').value as BetaResult,
        notes: getInput('evidence-notes').value,
        hooks: window as unknown as BetaHookSource,
      })
        .then((payload) =>
          requestJson<{ evidenceId: string }>(
            '/api/beta/evidence',
            session.sessionToken,
            { method: 'POST', body: JSON.stringify(payload) }
          )
        )
        .then((result) => {
          addEvent('Saved evidence result.', { evidenceId: result.evidenceId })
          setPhase('evidence')
          addSimpleLog('Evidence saved — sending your logs now.', 'ok')
          setFeedback('evidence-status', 'Evidence saved. Sending your logs now...', 'ok')
          // Auto-send logs immediately after evidence is saved
          void autoSendLogs()
        })
        .catch((err) => setFeedback('evidence-status', `Evidence failed: ${(err as Error).message}`, 'err'))
    })

    document.getElementById('run-form')?.addEventListener('submit', (event) => {
      event.preventDefault()
      const auth = readAuth()
      if (!auth || auth.role !== 'admin') return
      setFeedback('run-status', 'Starting simulated test...')
      void requestJson<BetaRun & { testUrl: string; simulation?: BetaSimulation }>('/api/beta/runs', auth.token, {
        method: 'POST',
        body: JSON.stringify({
          title: getInput('run-title').value,
          scenario: getInput('run-scenario').value,
          dataType: getInput('run-data-type').value,
          nodeCount: Number(getInput('run-node-count').value),
        }),
      })
        .then((run) => {
          addEvent('Admin started simulated test.', run)
          if (run.simulation) renderSimulation(run.simulation)
          setFeedback('run-status', `Run ready: ${run.roomId}`, 'ok')
          return refreshAdmin()
        })
        .catch((err) => setFeedback('run-status', `Run failed: ${(err as Error).message}`, 'err'))
    })

    document.getElementById('token-form')?.addEventListener('submit', (event) => {
      event.preventDefault()
      const auth = readAuth()
      if (!auth || auth.role !== 'admin') return
      setFeedback('token-status', 'Creating token...')
      void requestJson<{ token: string; role: BetaRole; tokenPreview: string }>('/api/beta/tokens', auth.token, {
        method: 'POST',
        body: JSON.stringify({
          label: getInput('new-token-label').value,
          role: getInput('new-token-role').value,
          assignedName: getInput('new-token-name').value,
          assignedEmail: getInput('new-token-email').value,
          welcomeNote: getInput('new-token-note').value,
          maxSessions: Number(getInput('new-token-max-sessions').value),
        }),
      })
        .then((token) => {
          setHidden('#created-token-box', false)
          setText('created-token-value', token.token)
          setFeedback('token-status', `${token.role} token created. Copy it now.`, 'ok')
          return refreshAdmin()
        })
        .catch((err) => setFeedback('token-status', `Token failed: ${(err as Error).message}`, 'err'))
    })
  })
}
