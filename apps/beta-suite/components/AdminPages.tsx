'use client'

import { useEffect, useState } from 'react'
import { AppShell, PageIntro } from './AppShell'
import { authenticate, createRun, createToken, getLedger, listAudit, listLogs, listPresence, listRuns, listSimulations, listTokens, postPresence, revokeToken, sendLog } from '../lib/beta-api'
import { readAuth, writeAuth } from '../lib/storage'
import type { AdminToken, AuditEvent, BetaLedger, BetaRun, BetaSimulation, PresencePeer, StoredAuth } from '../lib/types'

async function readVerifiedAdminAuth(): Promise<StoredAuth | null> {
  const auth = readAuth()
  if (!auth) return null
  const verified = await authenticate(auth.token)
  if (verified.role !== 'admin') return null
  const next = { ...verified, token: auth.token }
  writeAuth(next)
  return next
}

export function AdminOverviewPage() {
  const [state, setState] = useState({ tokens: '...', runs: '...', logs: '...', audit: '...' })
  const [status, setStatus] = useState('')
  useEffect(() => {
    void readVerifiedAdminAuth().then((auth) => {
      if (!auth) return
      return Promise.all([
      listTokens(auth.token),
      listRuns(auth.token),
      listLogs(auth.token),
      listAudit(auth.token),
      ])
    }).then((result) => {
      if (!result) return
      const [tokens, runs, logs, audit] = result
      setState({
        tokens: String(tokens.createdTokens.length),
        runs: String(runs.runs.length),
        logs: String(logs.logs.length),
        audit: String(audit.events.length),
      })
      setStatus('')
    }).catch((err) => {
      setState({ tokens: '!', runs: '!', logs: '!', audit: '!' })
      setStatus((err as Error).message)
    })
  }, [])
  return (
    <AppShell requireRole="admin">
      <PageIntro eyebrow="Admin lab" title="Coordinate beta tests." body="Create invites, start rooms, review logs, and keep the audit trail clean." />
      <section className="metric-grid">
        <Metric label="Created tokens" value={state.tokens} />
        <Metric label="Runs" value={state.runs} />
        <Metric label="Logs" value={state.logs} />
        <Metric label="Audit events" value={state.audit} />
      </section>
      {status ? <p className="status error">Admin data unavailable: {status}</p> : null}
    </AppShell>
  )
}

export function AdminTokensPage() {
  const [tokens, setTokens] = useState<AdminToken[]>([])
  const [created, setCreated] = useState('')
  const [status, setStatus] = useState('')
  const [form, setForm] = useState({ label: '', role: 'tester', assignedName: '', assignedEmail: '', welcomeNote: '', maxSessions: 1 })

  async function refresh() {
    const auth = await readVerifiedAdminAuth()
    if (!auth) return
    const result = await listTokens(auth.token)
    setTokens(result.createdTokens)
  }

  useEffect(() => { void refresh() }, [])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const auth = await readVerifiedAdminAuth()
    if (!auth) return
    setStatus('Creating token...')
    try {
      const token = await createToken(auth.token, form)
      setCreated(token.token)
      setStatus(`${token.role} token created. Copy it now.`)
      await refresh()
    } catch (err) {
      setStatus((err as Error).message)
    }
  }

  async function revoke(id: string) {
    const auth = await readVerifiedAdminAuth()
    if (!auth) return
    await revokeToken(auth.token, id)
    setStatus('Token revoked.')
    await refresh()
  }

  return (
    <AppShell requireRole="admin">
      <PageIntro eyebrow="Tokens" title="Create controlled access." body="Create one invite per tester. Revoke any token instantly." />
      <section className="admin-two-col">
        <form className="form-stack" onSubmit={submit}>
          <label>Label<input aria-label="Label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></label>
          <label>Role<select aria-label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="tester">Tester</option><option value="admin">Admin</option></select></label>
          <label>Tester name<input aria-label="Tester name" value={form.assignedName} onChange={(e) => setForm({ ...form, assignedName: e.target.value })} /></label>
          <label>Tester email<input aria-label="Tester email" value={form.assignedEmail} onChange={(e) => setForm({ ...form, assignedEmail: e.target.value })} /></label>
          <label>Personal note<textarea aria-label="Personal note" value={form.welcomeNote} onChange={(e) => setForm({ ...form, welcomeNote: e.target.value })} /></label>
          <label>Max sessions<input aria-label="Max sessions" type="number" min="1" max="20" value={form.maxSessions} onChange={(e) => setForm({ ...form, maxSessions: Number(e.target.value) })} /></label>
          <button className="primary-button" type="submit">Create token</button>
          <p className="status">{status}</p>
          {created ? <pre className="created-token">{created}</pre> : null}
        </form>
        <TokenTable tokens={tokens} onRevoke={revoke} />
      </section>
    </AppShell>
  )
}

export function AdminRunsPage() {
  const [runs, setRuns] = useState<BetaRun[]>([])
  const [simulation, setSimulation] = useState<BetaSimulation | undefined>()
  const [status, setStatus] = useState('')
  const [form, setForm] = useState({ title: '', scenario: 'epidemic-gossip', dataType: 'product-catalog', nodeCount: 10 })
  const [coordinatorName, setCoordinatorName] = useState('')
  const [activeRun, setActiveRun] = useState<BetaRun | null>(null)
  const [presence, setPresence] = useState<PresencePeer[]>([])

  async function refresh() {
    const auth = await readVerifiedAdminAuth()
    if (!auth) return
    const result = await listRuns(auth.token)
    setRuns(result.runs)
  }

  useEffect(() => {
    setCoordinatorName(localStorage.getItem('nodex-admin-coordinator-name-v1') ?? '')
    void refresh()
  }, [])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const auth = await readVerifiedAdminAuth()
    if (!auth) return
    setStatus('Starting simulated test...')
    try {
      const run = await createRun(auth.token, form)
      setStatus(`Run ready: ${run.roomId}`)
      setSimulation(run.simulation)
      setRuns((current) => [run, ...current.filter((item) => item.runId !== run.runId)])
    } catch (err) {
      setStatus((err as Error).message)
    }
  }

  async function postCoordinatorHeartbeat(run: BetaRun, logJoin: boolean) {
    const auth = await readVerifiedAdminAuth()
    if (!auth) return
    const name = coordinatorName.trim() || 'Coordinator'
    localStorage.setItem('nodex-admin-coordinator-name-v1', name)
    const result = await postPresence(auth.token, {
      name,
      mode: run.nodeCount > 2 ? 'group' : 'duo',
      roomId: run.roomId,
      participantId: `coordinator-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'admin'}`,
    })
    setPresence(result.online)
    if (logJoin) {
      await sendLog(auth.token, {
        runId: run.runId,
        roomId: run.roomId,
        level: 'info',
        message: 'Coordinator joined live room.',
        details: { title: run.title, scenario: run.scenario, nodeCount: run.nodeCount },
      }).catch(() => undefined)
    }
  }

  async function refreshActivePresence(run: BetaRun) {
    const auth = await readVerifiedAdminAuth()
    if (!auth) return
    const result = await listPresence(auth.token, run.roomId)
    setPresence(result.online)
  }

  async function joinAsCoordinator(run: BetaRun) {
    setStatus(`Joining ${run.roomId} as coordinator...`)
    try {
      setActiveRun(run)
      await postCoordinatorHeartbeat(run, true)
      setStatus(`Coordinator visible in ${run.roomId}. Keep this page open during the test.`)
    } catch (err) {
      setStatus((err as Error).message)
    }
  }

  useEffect(() => {
    if (!activeRun) return undefined
    void refreshActivePresence(activeRun).catch(() => undefined)
    const interval = window.setInterval(() => {
      void postCoordinatorHeartbeat(activeRun, false).catch(() => undefined)
    }, 8_000)
    return () => window.clearInterval(interval)
  }, [activeRun, coordinatorName])

  return (
    <AppShell requireRole="admin">
      <PageIntro eyebrow="Runs" title="Start test rooms." body="Create a room, share the invite, and watch results arrive." />
      <section className="admin-two-col">
        <form className="form-stack" onSubmit={submit}>
          <label>Run title<input aria-label="Run title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
          <label>Scenario<input aria-label="Scenario" value={form.scenario} onChange={(e) => setForm({ ...form, scenario: e.target.value })} /></label>
          <label>Data type<input aria-label="Data type" value={form.dataType} onChange={(e) => setForm({ ...form, dataType: e.target.value })} /></label>
          <label>Node count<input aria-label="Node count" type="number" value={form.nodeCount} onChange={(e) => setForm({ ...form, nodeCount: Number(e.target.value) })} /></label>
          <label>Coordinator name<input aria-label="Coordinator name" value={coordinatorName} onChange={(e) => setCoordinatorName(e.target.value)} placeholder="Name testers should see" /></label>
          <button className="primary-button" type="submit">Start simulated test</button>
          <p className="status">{status}</p>
        </form>
        <div className="table-card">
          <h3>Recent runs</h3>
          {runs.map((run) => (
            <p key={run.runId}>
              <b>{run.roomId}</b> {run.scenario} {run.nodeCount} nodes
              <button className="ghost-button inline-mini" type="button" onClick={() => { void joinAsCoordinator(run) }}>Join as coordinator</button>
            </p>
          ))}
          {simulation ? <p className="highlight">Hit rate: <b id="sim-hit-rate">{simulation.metrics.hitRatePct}%</b></p> : null}
          <AdminLiveRoom run={activeRun} presence={presence} />
        </div>
      </section>
    </AppShell>
  )
}

export function AdminMonitorPage() {
  const [logs, setLogs] = useState<Array<{ logId: string; message: string; level: string; tokenRole: string; createdAt?: string }>>([])
  const [simulations, setSimulations] = useState<BetaSimulation[]>([])
  useEffect(() => {
    void readVerifiedAdminAuth().then((auth) => {
      if (!auth) return
      void listLogs(auth.token).then((r) => setLogs(r.logs)).catch(() => undefined)
      void listSimulations(auth.token).then((r) => setSimulations((r.simulations.filter(Boolean) as BetaSimulation[]))).catch(() => undefined)
    }).catch(() => undefined)
  }, [])
  return (
    <AppShell requireRole="admin">
      <PageIntro eyebrow="Monitor" title="Watch test activity." body="Tester logs and simulated requests appear here." />
      <section className="admin-two-col">
        <Timeline title="Logs" items={logs.map((log) => `${log.level} ${log.tokenRole}: ${log.message}`)} />
        <Timeline title="Simulated requests" items={simulations.flatMap((sim) => sim.events.slice(0, 8).map((event) => `${event.nodeId} ${event.source} ${event.latencyMs}ms`))} />
      </section>
    </AppShell>
  )
}

export function AdminLedgerPage() {
  const [ledger, setLedger] = useState<BetaLedger | null>(null)
  useEffect(() => {
    void readVerifiedAdminAuth().then((auth) => {
      if (auth) void getLedger(auth.token).then(setLedger).catch(() => undefined)
    }).catch(() => undefined)
  }, [])
  return (
    <AppShell requireRole="admin">
      <PageIntro eyebrow="Ledger" title="Evidence ledger." body="Use this for attribution review. It is not a legal inventorship decision." />
      <section className="table-card">
        <h3>Participants</h3>
        {ledger?.participants.map((p) => <p key={p.participantId}><b>{p.name}</b> {p.city ?? ''} {p.country ?? ''} - {p.evidenceCount} evidence records</p>)}
      </section>
    </AppShell>
  )
}

export function AdminAuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([])
  useEffect(() => {
    void readVerifiedAdminAuth().then((auth) => {
      if (auth) void listAudit(auth.token).then((r) => setEvents(r.events)).catch(() => undefined)
    }).catch(() => undefined)
  }, [])
  return (
    <AppShell requireRole="admin">
      <PageIntro eyebrow="Audit" title="Admin trail." body="Token, login, evidence, and run events stay visible here." />
      <Timeline title="Recent audit events" items={events.map((event) => `${event.severity} ${event.eventType} ${event.targetType ?? ''} ${event.targetId ?? ''}`)} />
    </AppShell>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>
}

function TokenTable({ tokens, onRevoke }: { tokens: AdminToken[]; onRevoke: (id: string) => void }) {
  return (
    <div className="table-card">
      <h3>Created tokens</h3>
      <div className="token-list">
        {tokens.map((token) => {
          const revoked = !token.active || Boolean(token.revokedAt)
          return (
            <article key={token.tokenId}>
              <div><b>{token.label}</b><span>{token.role} - {token.tokenPreview}</span></div>
              <span className={revoked ? 'pill danger' : 'pill'}>{revoked ? 'revoked' : 'active'}</span>
              {!revoked ? <button className="danger-button" type="button" onClick={() => onRevoke(token.tokenId)}>Revoke</button> : null}
            </article>
          )
        })}
      </div>
    </div>
  )
}

function Timeline({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="table-card">
      <h3>{title}</h3>
      {items.length === 0 ? <p>No records yet.</p> : items.map((item, index) => <p key={`${item}-${index}`}>{item}</p>)}
    </section>
  )
}

function AdminLiveRoom({ run, presence }: { run: BetaRun | null; presence: PresencePeer[] }) {
  if (!run) {
    return (
      <div className="admin-live-room">
        <h3>Live room</h3>
        <p>Join a recent run as coordinator to watch live room presence here.</p>
      </div>
    )
  }

  return (
    <div className="admin-live-room">
      <div className="admin-live-room-header">
        <div>
          <span>Live room</span>
          <strong>{run.title || run.roomId}</strong>
        </div>
        <b>{presence.length}/{run.nodeCount} visible</b>
      </div>
      <div className="admin-presence-list">
        {presence.length === 0 ? <p>No visible nodes yet.</p> : presence.map((peer) => (
          <p key={`${peer.role}-${peer.participantId ?? peer.name}`}>
            <b>{peer.name}</b>
            <span>{peer.role} / {peer.mode}</span>
          </p>
        ))}
      </div>
    </div>
  )
}
