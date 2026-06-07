import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBetaCoordinatorApp, createBetaStore } from './beta-coordinator.js'

describe('beta coordinator auth and evidence capture', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'nodex-beta-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('rejects beta session creation without a valid invite token', async () => {
    const app = createBetaCoordinatorApp({ dataDir, inviteTokens: ['alpha-token'] })

    const missing = await app.request('/api/beta/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ada Tester' }),
    })
    const invalid = await app.request('/api/beta/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ name: 'Ada Tester' }),
    })

    expect(missing.status).toBe(401)
    expect(invalid.status).toBe(401)
  })

  it('creates a beta session with contributor consent and never echoes the invite token', async () => {
    const app = createBetaCoordinatorApp({ dataDir, inviteTokens: ['alpha-token'] })

    const response = await app.request('/api/beta/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer alpha-token' },
      body: JSON.stringify({
        name: 'Ada Tester',
        email: 'ada@example.test',
        city: 'Sao Paulo',
        country: 'BR',
        networkLabel: 'home-wifi',
        consentToCredit: true,
        contributionNote: 'Ran LAN validation and reported candidate telemetry.',
      }),
    })
    const body = await response.json() as {
      participantId: string
      sessionToken: string
      roomId: string
      testUrl: string
    }

    expect(response.status).toBe(201)
    expect(body.participantId).toMatch(/^beta-/)
    expect(body.sessionToken).toMatch(/^beta-session-/)
    expect(body.roomId).toContain(body.participantId)
    expect(body.testUrl).toContain(`nodexRoom=${encodeURIComponent(body.roomId)}`)
    expect(JSON.stringify(body)).not.toContain('alpha-token')

    const participants = await readFile(path.join(dataDir, 'participants.jsonl'), 'utf8')
    expect(participants).toContain('Ada Tester')
    expect(participants).toContain('consentToCredit')
    expect(participants).not.toContain('alpha-token')
  })

  it('accepts telemetry evidence only with a valid beta session token', async () => {
    const app = createBetaCoordinatorApp({ dataDir, inviteTokens: ['alpha-token'] })
    const sessionResponse = await app.request('/api/beta/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer alpha-token' },
      body: JSON.stringify({ name: 'Grace Tester', consentToCredit: true }),
    })
    const session = await sessionResponse.json() as { participantId: string; sessionToken: string; roomId: string }

    const unauthorized = await app.request('/api/beta/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantId: session.participantId, roomId: session.roomId }),
    })
    expect(unauthorized.status).toBe(401)

    const authorized = await app.request('/api/beta/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.sessionToken}` },
      body: JSON.stringify({
        participantId: session.participantId,
        roomId: session.roomId,
        topologyLabel: 'lan-multi-machine',
        result: 'pass',
        notes: 'Two same-city machines on the same LAN connected.',
        telemetry: [{ selected_candidate_type: 'host', connection_state: 'connected' }],
        lifecycleSignals: [{ type: 'visibilitychange', hidden: true }],
        deviceHints: { userAgent: 'Mozilla/5.0 Test', mobile: false, maxTouchPoints: 0 },
      }),
    })

    expect(authorized.status).toBe(201)
    const evidence = await readFile(path.join(dataDir, 'evidence.jsonl'), 'utf8')
    expect(evidence).toContain('lan-multi-machine')
    expect(evidence).toContain('selected_candidate_type')
    expect(evidence).toContain('visibilitychange')
    expect(evidence).toContain('Mozilla/5.0 Test')
    expect(evidence).toContain(session.participantId)
  })

  it('exports a contributor ledger grouped from persisted participants and evidence', async () => {
    const store = createBetaStore(dataDir)
    const participant = await store.createParticipant({
      name: 'Lin Tester',
      email: 'lin@example.test',
      city: 'Lisbon',
      country: 'PT',
      networkLabel: 'fiber',
      consentToCredit: true,
      contributionNote: 'Suggested testing cross-region relay behavior.',
    })
    await store.appendEvidence({
      participantId: participant.participantId,
      roomId: participant.roomId,
      topologyLabel: 'geographic-long-range',
      result: 'partial',
      notes: 'Cloud region edge connected but only one physical machine was available.',
      telemetry: [],
    })

    const ledger = await store.readLedger()

    expect(ledger.participants).toHaveLength(1)
    expect(ledger.participants[0]?.name).toBe('Lin Tester')
    expect(ledger.participants[0]?.evidenceCount).toBe(1)
    expect(ledger.participants[0]?.contributionNote).toContain('cross-region')
    expect(ledger.notice).toContain('not a legal inventorship determination')
  })

  it('detects token roles and restricts admin-only endpoints', async () => {
    const app = createBetaCoordinatorApp({
      dataDir,
      inviteTokens: ['tester-token'],
      adminTokens: ['admin-token'],
    })

    const testerAuth = await app.request('/api/beta/auth', {
      method: 'POST',
      headers: { Authorization: 'Bearer tester-token' },
    })
    const adminAuth = await app.request('/api/beta/auth', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-token' },
    })
    const forbidden = await app.request('/api/beta/tokens', {
      headers: { Authorization: 'Bearer tester-token' },
    })

    expect(testerAuth.status).toBe(200)
    expect(await testerAuth.json()).toMatchObject({ role: 'tester' })
    expect(adminAuth.status).toBe(200)
    expect(await adminAuth.json()).toMatchObject({ role: 'admin' })
    expect(forbidden.status).toBe(403)
  })

  it('lets admins create tester tokens and use them for beta sessions', async () => {
    const app = createBetaCoordinatorApp({ dataDir, inviteTokens: [], adminTokens: ['admin-token'] })

    const tokenResponse = await app.request('/api/beta/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-token' },
      body: JSON.stringify({
        label: 'Pilot user',
        role: 'tester',
        assignedName: 'Pilot Tester',
        assignedEmail: 'pilot@example.test',
        welcomeNote: 'This invite is reserved for your phone hotspot test.',
      }),
    })
    const tokenBody = await tokenResponse.json() as {
      token: string
      tokenHash: string
      tokenPreview: string
      role: string
      assignedName: string
      assignedEmail: string
      welcomeNote: string
      maxSessions: number
    }

    expect(tokenResponse.status).toBe(201)
    expect(tokenBody.token).toMatch(/^nodex-tester-/)
    expect(tokenBody.tokenHash).toHaveLength(64)
    expect(tokenBody.tokenPreview).not.toBe(tokenBody.token)
    expect(tokenBody.assignedName).toBe('Pilot Tester')
    expect(tokenBody.assignedEmail).toBe('pilot@example.test')
    expect(tokenBody.welcomeNote).toContain('reserved')
    expect(tokenBody.maxSessions).toBe(1)

    const sessionResponse = await app.request('/api/beta/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenBody.token}` },
      body: JSON.stringify({ name: 'Pilot Tester', consentToCredit: true }),
    })

    expect(sessionResponse.status).toBe(201)

    const reusedSessionResponse = await app.request('/api/beta/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenBody.token}` },
      body: JSON.stringify({ name: 'Pilot Tester Again', consentToCredit: true }),
    })

    expect(reusedSessionResponse.status).toBe(409)
  })

  it('lets admins create Supabase-style admin tokens without Vercel env updates and revoke them immediately', async () => {
    const app = createBetaCoordinatorApp({ dataDir, inviteTokens: [], adminTokens: ['root-admin-token'] })

    const createdResponse = await app.request('/api/beta/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer root-admin-token' },
      body: JSON.stringify({
        role: 'admin',
        label: 'Cofounder admin',
        assignedName: 'Cofounder',
        assignedEmail: 'cofounder@example.test',
        maxSessions: 20,
      }),
    })
    const created = await createdResponse.json() as { token: string; tokenId: string; role: string }
    expect(createdResponse.status).toBe(201)
    expect(created.role).toBe('admin')

    const adminAccess = await app.request('/api/beta/tokens', {
      headers: { Authorization: `Bearer ${created.token}` },
    })
    expect(adminAccess.status).toBe(200)

    const revokeResponse = await app.request(`/api/beta/tokens/${created.tokenId}/revoke`, {
      method: 'POST',
      headers: { Authorization: 'Bearer root-admin-token' },
    })
    expect(revokeResponse.status).toBe(200)

    const revokedAccess = await app.request('/api/beta/tokens', {
      headers: { Authorization: `Bearer ${created.token}` },
    })
    expect(revokedAccess.status).toBe(403)

    const auditResponse = await app.request('/api/beta/audit', {
      headers: { Authorization: 'Bearer root-admin-token' },
    })
    const audit = await auditResponse.json() as { events: Array<{ eventType: string; targetId?: string }> }
    expect(audit.events.some((event) => event.eventType === 'token_created' && event.targetId === created.tokenId)).toBe(true)
    expect(audit.events.some((event) => event.eventType === 'token_revoked' && event.targetId === created.tokenId)).toBe(true)
  })

  it('returns personalized invite metadata during auth for exclusive tester tokens', async () => {
    const app = createBetaCoordinatorApp({ dataDir, inviteTokens: [], adminTokens: ['admin-token'] })
    const tokenResponse = await app.request('/api/beta/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-token' },
      body: JSON.stringify({
        role: 'tester',
        label: 'Ana field tester',
        assignedName: 'Ana Field',
        assignedEmail: 'ana@example.test',
        welcomeNote: 'Ana, this invite is reserved for your home Wi-Fi test.',
      }),
    })
    const token = await tokenResponse.json() as { token: string }

    const authResponse = await app.request('/api/beta/auth', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.token}` },
    })
    const auth = await authResponse.json() as {
      role: string
      invite: { assignedName: string; assignedEmail: string; welcomeNote: string; maxSessions: number }
    }

    expect(authResponse.status).toBe(200)
    expect(auth.role).toBe('tester')
    expect(auth.invite.assignedName).toBe('Ana Field')
    expect(auth.invite.assignedEmail).toBe('ana@example.test')
    expect(auth.invite.welcomeNote).toContain('reserved')
    expect(auth.invite.maxSessions).toBe(1)
  })

  it('lets admins start simulated beta runs and collect tester logs', async () => {
    const app = createBetaCoordinatorApp({ dataDir, inviteTokens: ['tester-token'], adminTokens: ['admin-token'] })

    const runResponse = await app.request('/api/beta/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-token' },
      body: JSON.stringify({
        title: 'Same-city LAN rehearsal',
        scenario: 'epidemic-gossip',
        dataType: 'product-catalog',
        nodeCount: 8,
      }),
    })
    const run = await runResponse.json() as {
      runId: string
      roomId: string
      testUrl: string
      simulation: { simulationId: string; metrics: { totalRequests: number; hitRatePct: number } }
    }

    expect(runResponse.status).toBe(201)
    expect(run.runId).toMatch(/^run-/)
    expect(run.testUrl).toContain(`nodexRoom=${encodeURIComponent(run.roomId)}`)
    expect(run.simulation.simulationId).toMatch(/^sim-/)
    expect(run.simulation.metrics.totalRequests).toBe(40)
    expect(run.simulation.metrics.hitRatePct).toBeGreaterThan(70)

    const logResponse = await app.request('/api/beta/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tester-token' },
      body: JSON.stringify({
        runId: run.runId,
        roomId: run.roomId,
        level: 'info',
        message: 'Tester copied browser diagnostics.',
        details: { browser: 'chromium' },
      }),
    })

    expect(logResponse.status).toBe(201)

    const logsResponse = await app.request('/api/beta/logs', {
      headers: { Authorization: 'Bearer admin-token' },
    })
    const logs = await logsResponse.json() as { logs: Array<{ runId: string; tokenRole: string }> }

    expect(logs.logs[0]?.runId).toBe(run.runId)
    expect(logs.logs[0]?.tokenRole).toBe('tester')
  })

  it('lists coordinator-created rooms and filters presence by room', async () => {
    const app = createBetaCoordinatorApp({ dataDir, inviteTokens: ['tester-token'], adminTokens: ['admin-token'] })

    const runResponse = await app.request('/api/beta/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-token' },
      body: JSON.stringify({
        title: 'Davi plus tester',
        scenario: 'coordinator-duo',
        dataType: 'product-catalog',
        nodeCount: 2,
      }),
    })
    const run = await runResponse.json() as { runId: string; roomId: string; title: string }

    const roomsResponse = await app.request('/api/beta/rooms', {
      headers: { Authorization: 'Bearer tester-token' },
    })
    const rooms = await roomsResponse.json() as { rooms: Array<{ runId: string; roomId: string; title: string }> }

    expect(roomsResponse.status).toBe(200)
    expect(rooms.rooms).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: run.runId, roomId: run.roomId, title: 'Davi plus tester' }),
    ]))

    await app.request('/api/beta/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-token' },
      body: JSON.stringify({ name: 'Davi', mode: 'duo', roomId: run.roomId, participantId: 'coordinator-davi' }),
    })
    const testerPresenceResponse = await app.request('/api/beta/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tester-token' },
      body: JSON.stringify({ name: 'Ana Field', mode: 'duo', roomId: 'other-room', participantId: 'beta-ana' }),
    })
    const testerPresence = await testerPresenceResponse.json() as { online: Array<{ name: string; roomId: string }> }

    expect(testerPresence.online.map((peer) => peer.name)).toEqual(['Ana Field'])

    const roomPresenceResponse = await app.request(`/api/beta/presence?roomId=${encodeURIComponent(run.roomId)}`, {
      headers: { Authorization: 'Bearer tester-token' },
    })
    const roomPresence = await roomPresenceResponse.json() as { online: Array<{ name: string; roomId: string }> }

    expect(roomPresence.online.map((peer) => peer.name)).toEqual(['Davi'])
  })

  it('exposes backend simulation control-plane summaries to admins', async () => {
    const app = createBetaCoordinatorApp({ dataDir, inviteTokens: ['tester-token'], adminTokens: ['admin-token'] })

    const simulationResponse = await app.request('/api/beta/simulations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-token' },
      body: JSON.stringify({
        title: 'Backend request simulation',
        scenario: 'p2p-cache-hit',
        dataType: 'inventory-price',
        nodeCount: 12,
        requestCount: 24,
      }),
    })
    const simulationBody = await simulationResponse.json() as {
      run: { runId: string }
      simulation: {
        requestCount: number
        metrics: { totalRequests: number; serverFallback: number; estimatedOriginReadsAvoided: number }
        events: Array<{ source: string; latencyMs: number }>
      }
    }

    expect(simulationResponse.status).toBe(201)
    expect(simulationBody.run.runId).toMatch(/^run-/)
    expect(simulationBody.simulation.requestCount).toBe(24)
    expect(simulationBody.simulation.metrics.totalRequests).toBe(24)
    expect(simulationBody.simulation.metrics.serverFallback).toBeGreaterThan(0)
    expect(simulationBody.simulation.metrics.estimatedOriginReadsAvoided).toBeGreaterThan(0)
    expect(simulationBody.simulation.events[0]?.latencyMs).toBeGreaterThan(0)

    const controlResponse = await app.request('/api/beta/control', {
      headers: { Authorization: 'Bearer admin-token' },
    })
    const control = await controlResponse.json() as {
      totals: { runs: number; simulations: number }
      latestSimulation: { simulationId: string } | null
    }

    expect(controlResponse.status).toBe(200)
    expect(control.totals.runs).toBe(1)
    expect(control.totals.simulations).toBe(1)
    expect(control.latestSimulation?.simulationId).toMatch(/^sim-/)
  })
})
