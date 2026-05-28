'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { betaApiBase, createSession, listPresence, listRooms, postPresence, sendLog, submitEvidence } from '../lib/beta-api'
import {
  addLog,
  buildLogBundle,
  isRoomOpen,
  readActiveRoom,
  readAuth,
  readLogs,
  readProfile,
  readSession,
  setRoomOpen,
  writeActiveRoom,
  writeProfile,
  writeSession,
} from '../lib/storage'
import type { BetaResult, BetaRoom, BetaSession, PresencePeer, StoredAuth, TesterProfile } from '../lib/types'
import { PageIntro, TesterLayout } from './AppShell'

type RoomMode = 'solo' | 'duo' | 'group'
type LiveNodeState = 'ready' | 'connecting' | 'waiting' | 'offline'

interface LiveNode {
  id: string
  label: string
  role: string
  state: LiveNodeState
  x: number
  y: number
}

interface BrowserDiagnostic {
  label: string
  ok: boolean
  detail: string
}

export function SetupPage() {
  const [auth, setAuth] = useState<StoredAuth | null>(null)
  useEffect(() => setAuth(readAuth()), [])
  return (
    <TesterLayout current="setup">
      <PageIntro
        eyebrow="Access confirmed"
        title={`Welcome${auth?.invite?.assignedName ? `, ${auth.invite.assignedName}` : ''}.`}
        body={auth?.invite?.welcomeNote ?? 'You will confirm your profile, open a test room, run the guide, and send your result.'}
        aside={<StatusCard label="Invite" value={auth?.tokenPreview ?? 'checking'} />}
      />
      <section className="workflow-cards">
        <article><span>1</span><h3>Confirm profile</h3><p>Your basic details are saved on this browser.</p></article>
        <article><span>2</span><h3>Open room</h3><p>Your assigned test room appears here.</p></article>
        <article><span>3</span><h3>Send result</h3><p>Choose what happened and send the logs.</p></article>
      </section>
      <Link className="primary-button inline-action" href="/profile">Start setup</Link>
    </TesterLayout>
  )
}

export function ProfilePage() {
  const router = useRouter()
  const [auth, setAuth] = useState<StoredAuth | null>(null)
  const [profile, setProfile] = useState<TesterProfile>({ name: '', email: '', city: '', country: '', networkLabel: '', consentToCredit: false })
  const [note, setNote] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => {
    const stored = readAuth()
    setAuth(stored)
    if (stored) setProfile(readProfile(stored))
  }, [])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!auth) return
    if (!profile.name.trim()) {
      setStatus('Name is required.')
      return
    }
    if (!profile.consentToCredit) {
      setStatus('Consent is required to submit beta evidence.')
      return
    }
    setStatus('Saving profile...')
    writeProfile(auth, profile)
    try {
      const session = await createSession(auth.token, { ...profile, contributionNote: note })
      writeSession(session)
      addLog('Profile saved and tester session created.', 'info', { participantId: session.participantId, roomId: session.roomId })
      router.push('/room')
    } catch (err) {
      setStatus((err as Error).message)
    }
  }

  return (
    <TesterLayout current="profile">
      <PageIntro eyebrow="Tester profile" title="Confirm who is testing." body="These details stay in this browser. The note is only for this run." />
      <form className="form-grid profile-form" onSubmit={submit}>
        <label>Name<input aria-label="Name" value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} /></label>
        <label>Email<input aria-label="Email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} /></label>
        <label>City<input aria-label="City" value={profile.city} onChange={(e) => setProfile({ ...profile, city: e.target.value })} /></label>
        <label>Country<input aria-label="Country" value={profile.country} onChange={(e) => setProfile({ ...profile, country: e.target.value })} /></label>
        <label className="wide">Network<input aria-label="Network" value={profile.networkLabel} onChange={(e) => setProfile({ ...profile, networkLabel: e.target.value })} placeholder="home wifi, hotspot, office, cloud" /></label>
        <label className="wide">Contribution note<textarea aria-label="Contribution note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything useful you noticed during this specific run." /></label>
        <label className="checkbox wide"><input aria-label="Consent to be credited" type="checkbox" checked={profile.consentToCredit} onChange={(e) => setProfile({ ...profile, consentToCredit: e.target.checked })} /> I consent to be credited in the Nodex contributor/test evidence ledger.</label>
        <button className="primary-button wide" type="submit">Save profile and continue</button>
      </form>
      <p className={status.includes('required') || status.includes('already') ? 'status error' : 'status'}>{status}</p>
    </TesterLayout>
  )
}

export function RoomPage() {
  const router = useRouter()
  const [session, setSession] = useState<BetaSession | null>(null)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<RoomMode>('solo')
  const [diagnostics, setDiagnostics] = useState<BrowserDiagnostic[]>([])
  const [roomLogs, setRoomLogs] = useState<string[]>([])
  const [onlinePeers, setOnlinePeers] = useState<PresencePeer[]>([])
  const [selfName, setSelfName] = useState('You')
  const [rooms, setRooms] = useState<BetaRoom[]>([])
  const [selectedRoomId, setSelectedRoomId] = useState('')
  const [roomStatusText, setRoomStatusText] = useState('')
  useEffect(() => {
    const active = readActiveRoom()
    const storedSession = readSession()
    setSession(storedSession)
    setOpen(isRoomOpen())
    if (active?.mode === 'duo' || active?.mode === 'group') setMode(active.mode)
    const auth = readAuth()
    if (auth) {
      const profile = readProfile(auth)
      setSelfName(profile.name.trim() || auth.invite?.assignedName || 'You')
      void listRooms(auth.token).then((result) => {
        setRooms(result.rooms)
        const activeRoomId = active?.roomId && result.rooms.some((room) => room.roomId === active.roomId)
          ? active.roomId
          : result.rooms[0]?.roomId ?? ''
        setSelectedRoomId(activeRoomId)
      }).catch(() => undefined)
    }
  }, [])

  const activeRoomId = mode === 'solo' ? session?.roomId ?? '' : selectedRoomId
  const activeRoom = rooms.find((room) => room.roomId === selectedRoomId)
  const nodes = buildLiveNodes(mode, open, session, selfName, onlinePeers)
  const ready = open && diagnostics.some((check) => check.label === 'Browser storage' && check.ok) && nodes.some((node) => node.id === 'self' && node.state === 'ready')

  useEffect(() => {
    if (!activeRoomId) {
      setOnlinePeers([])
      return undefined
    }

    if (open && session) {
      void refreshPresence(mode, session, activeRoomId, false)
      const interval = window.setInterval(() => {
        void refreshPresence(mode, session, activeRoomId, false)
      }, 8_000)
      return () => window.clearInterval(interval)
    }

    if (mode !== 'solo') {
      void refreshRoomPresence(activeRoomId)
      const interval = window.setInterval(() => {
        void refreshRoomPresence(activeRoomId)
      }, 8_000)
      return () => window.clearInterval(interval)
    }

    setOnlinePeers([])
    return undefined
  }, [activeRoomId, mode, open, session])

  async function refreshRoomPresence(roomId: string) {
    const auth = readAuth()
    if (!auth) return
    try {
      const result = await listPresence(auth.token, roomId)
      setOnlinePeers(result.online)
    } catch {
      // Presence is best-effort; the room can still be joined.
    }
  }

  async function openRoom() {
    if (!session) {
      if (mode !== 'solo' && activeRoomId) {
        writeActiveRoom({ roomId: activeRoomId, mode })
      }
      router.push('/profile')
      return
    }
    const roomId = activeRoomId
    if (mode !== 'solo' && !roomId) {
      setRoomStatusText('Choose an open room first.')
      return
    }
    setRoomOpen(true)
    writeActiveRoom({ roomId, mode })
    setOpen(true)
    setRoomStatusText(mode === 'solo' ? 'Solo room opened.' : 'Joined selected test room.')
    pushRoomLog(mode === 'solo' ? 'Solo room opened in this browser.' : `Joined room ${roomId}.`)
    const checks = await collectBrowserDiagnostics()
    setDiagnostics(checks)
    addLog('Hybrid live room opened.', 'info', { roomId, mode, diagnostics: checks })
    await refreshPresence(mode, session, roomId, true)
  }

  async function refreshPresence(roomMode: RoomMode, activeSession: BetaSession, roomId: string, logChange: boolean) {
    const auth = readAuth()
    if (!auth) return
    const profile = readProfile(auth)
    const name = profile.name.trim() || auth.invite?.assignedName || (auth.role === 'admin' ? 'Admin' : 'Tester')
    try {
      const result = await postPresence(auth.token, {
        name,
        mode: roomMode,
        participantId: activeSession.participantId,
        roomId,
      })
      setOnlinePeers(result.online)
      if (logChange) pushRoomLog(`${result.online.length} visible consumer node${result.online.length === 1 ? '' : 's'} online.`)
      if (logChange) {
        await sendLog(auth.token, {
          participantId: activeSession.participantId,
          roomId,
          level: 'info',
          message: 'Tester joined live room.',
          details: { mode: roomMode, visibleNodes: result.online.map((peer) => ({ name: peer.name, role: peer.role, roomId: peer.roomId })) },
        }).catch(() => undefined)
      }
    } catch (err) {
      if (logChange) pushRoomLog(`Presence unavailable: ${(err as Error).message}`)
    }
  }

  function pushRoomLog(message: string) {
    const stamped = `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${message}`
    setRoomLogs((current) => [stamped, ...current].slice(0, 8))
  }

  return (
    <TesterLayout current="room">
      <PageIntro
        eyebrow="Live test room"
        title="Watch the room connect."
        body="Solo runs use your assigned room. Shared runs are opened by the coordinator and joined from the list."
        aside={<StatusCard label="Status" value={roomStatus(mode, open, onlinePeers)} tone={ready ? 'ok' : 'warn'} />}
      />
      <section className={open ? 'hybrid-room active-room' : 'hybrid-room'}>
        <div className="room-control-card">
          <p className="eyebrow">Room</p>
          <h2>{mode === 'solo' ? session?.roomId ?? 'Confirm profile first' : activeRoom?.title || activeRoomId || 'Select shared room'}</h2>
          <p>{session ? 'This view only marks nodes ready after the backend sees their live heartbeat in the same room.' : 'Confirm your tester profile once, then join this shared room.'}</p>
          <div className="mode-switch" aria-label="Test room mode">
            {(['solo', 'duo', 'group'] as const).map((item) => (
              <button key={item} className={mode === item ? 'active' : ''} type="button" onClick={() => setMode(item)}>
                {item === 'solo' ? 'Solo' : item === 'duo' ? 'Coordinator + tester' : 'Group'}
              </button>
            ))}
          </div>
          {mode !== 'solo' ? (
            <div className="room-picker">
              <span>Open rooms</span>
              {rooms.length === 0 ? <p>Nenhuma sala encontrada.</p> : rooms.map((room) => (
                <button key={room.roomId} className={selectedRoomId === room.roomId ? 'active' : ''} type="button" onClick={() => setSelectedRoomId(room.roomId)}>
                  <b>{room.title || room.roomId}</b>
                  <small>{room.nodeCount} nodes / {room.scenario}</small>
                </button>
              ))}
            </div>
          ) : null}
          {session?.testUrl ? <a className="test-url" href={roomTestUrl(session.testUrl, activeRoomId)} target="_blank" rel="noreferrer">Open external test tab</a> : null}
          <div className="room-actions">
            <button className="soft-button" type="button" onClick={() => { void openRoom() }}>{!session ? 'Confirm profile to join' : mode === 'solo' ? 'Open solo room' : 'Join selected room'}</button>
            <button className="primary-button" type="button" disabled={!session || !open} onClick={() => router.push('/run')}>Run guided test</button>
          </div>
          {roomStatusText ? <p className="status">{roomStatusText}</p> : null}
        </div>

        <div className="mesh-card" aria-label="Live connection map">
          <LiveMesh nodes={nodes} roomLabel={mode === 'solo' ? 'Solo room' : activeRoom?.title || activeRoomId || 'Select room'} />
          <div className="mesh-status">
            <span>Status</span>
            <strong>{roomStatus(mode, open, onlinePeers)}</strong>
          </div>
        </div>

        <div className="diagnostics-card">
          <h3>Browser checks</h3>
          {diagnostics.length === 0 ? <p>Open the room to check this browser.</p> : diagnostics.map((check) => (
            <p key={check.label} className={check.ok ? 'check-ok' : 'check-warn'}>
              <b>{check.label}</b>
              <span>{check.detail}</span>
            </p>
          ))}
        </div>

        <div className="room-log-card">
          <h3>Room log</h3>
          {roomLogs.length === 0 ? <p>No room events yet.</p> : roomLogs.map((item) => <p key={item}>{item}</p>)}
        </div>
      </section>
    </TesterLayout>
  )
}

export function RunPage() {
  const router = useRouter()
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [step, setStep] = useState(0)
  const [running, setRunning] = useState(false)
  const [summary, setSummary] = useState('')
  const [details, setDetails] = useState<string[]>([])
  const [runtimeUrl, setRuntimeUrl] = useState('')
  const steps = useMemo(() => [
    'Service Worker controls this browser',
    'Peer manager joined the room',
    'Encrypted origin fetch completed',
    'Cache/P2P transfer metrics captured',
    'Gossip invalidation seeded',
    'Evidence bundle prepared',
  ], [])

  async function run() {
    setStep(0)
    setRunning(true)
    setSummary('Starting real protocol test...')
    setDetails([])
    const auth = readAuth()
    const session = readSession()
    const activeRoom = readActiveRoom()
    const roomId = activeRoom?.roomId || session?.roomId
    const mode = activeRoom?.mode || 'solo'
    if (!auth || !session || !roomId) {
      setSummary('Create and open a test room before running protocol checks.')
      setRunning(false)
      return
    }

    const metricEvents: Array<{ type: string; key?: string; latency_ms?: number }> = []
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('nodex-metrics') : null
    if (channel) {
      channel.onmessage = (event: MessageEvent) => {
        metricEvents.push(event.data as { type: string; key?: string; latency_ms?: number })
      }
    }

    const record = (message: string) => {
      addLog(message)
      setDetails((current) => [message, ...current].slice(0, 10))
    }

    try {
      const signalBase = `${betaApiBase()}/api/signal`
      const runtime = buildRuntimeUrl(roomId, mode, signalBase, auth.token)
      setRuntimeUrl(runtime)
      const runtimeWindow = await waitForRuntimeFrame(frameRef, runtime)
      setStep(1)
      record('Protocol runtime loaded in this browser.')

      await waitForCondition(() => Boolean((runtimeWindow as unknown as Record<string, unknown>)['__peerManagerReady']), 8000)
      setStep(2)
      record(`Peer manager joined ${roomId}.`)

      const first = await runtimeWindow.fetch('/api/products/1', { cache: 'no-store' })
      if (!first.ok) throw new Error(`origin fetch failed (${first.status})`)
      setStep(3)
      record(`Encrypted origin fetch ok, seq=${first.headers.get('X-Nodex-Seq') ?? '?'}.`)

      for (let i = 0; i < 6; i++) {
        const productId = (i % 3) + 1
        const res = await runtimeWindow.fetch(`/api/products/${productId}`)
        if (!res.ok) throw new Error(`fetch /api/products/${productId} failed (${res.status})`)
        await sleep(100)
      }
      await sleep(600)

      const counts = countMetrics(metricEvents)
      const peerCount = connectedPeerCount(runtimeWindow)
      setStep(4)
      record(`Metrics captured: SW ${counts.swCache}, P2P ${counts.peerFetch}, server ${counts.serverFallback}; peers ${peerCount}.`)

      const invalidate = await runtimeWindow.fetch('/api/invalidate/products/1', { method: 'POST' })
      if (invalidate.ok) {
        const body = await invalidate.json() as { seq?: number; newSeq?: number }
        const seq = body.seq ?? body.newSeq ?? 1
        await fetch(`${signalBase}/gossip-seed`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${auth.token}`,
          },
          body: JSON.stringify({ roomId, key: '/api/products/1', seq, originNodeId: 'beta-next-runner' }),
        }).catch(() => undefined)
        record(`Gossip invalidation seeded for /api/products/1 seq=${seq}.`)
      } else {
        record(`Invalidation endpoint returned ${invalidate.status}; gossip seed skipped.`)
      }
      setStep(5)
      await sleep(1000)

      const telemetry = await collectProtocolTelemetry(runtimeWindow)
      const capture = readP2PCapture(runtimeWindow)
      const finalCounts = countMetrics(metricEvents)
      const evidence = {
        roomId,
        mode,
        peerCount: connectedPeerCount(runtimeWindow),
        metrics: finalCounts,
        telemetryCount: telemetry.length,
        p2pCapture: capture,
        runtimeConfig: (runtimeWindow as unknown as Record<string, () => unknown>)['__nodexRuntimeConfig']?.(),
      }
      record(`Runtime evidence: ${evidence.peerCount} connected peer(s), ${evidence.telemetryCount} telemetry sample(s).`)
      await sendLog(auth.token, {
        participantId: session.participantId,
        roomId,
        level: evidence.peerCount > 0 || mode === 'solo' ? 'info' : 'warn',
        message: 'Tester ran real Nodex protocol check from Next beta suite.',
        details: evidence,
      }).catch(() => undefined)

      setStep(6)
      const p2pText = finalCounts.peerFetch > 0
        ? 'P2P data transfer observed.'
        : evidence.peerCount > 0
          ? 'Peer connection observed; P2P transfer may need the other node to seed the same key first.'
          : 'No peer connected yet; this run only proves local SW/origin path.'
      setSummary(`${p2pText} SW ${finalCounts.swCache}, P2P ${finalCounts.peerFetch}, server ${finalCounts.serverFallback}.`)
    } catch (err) {
      setSummary(`Protocol test failed: ${(err as Error).message}`)
      record(`Protocol test failed: ${(err as Error).message}`)
    } finally {
      channel?.close()
      setRunning(false)
    }
  }

  return (
    <TesterLayout current="run">
      <PageIntro eyebrow="Real browser protocol test" title="Run the test here." body="This runs the Service Worker, joins the P2P room, fetches encrypted data, and records cache/P2P/gossip evidence." />
      <section className="run-panel">
        <ol className="run-steps">
          {steps.map((message, index) => <li key={message} className={step > index ? 'done' : ''}>{message}</li>)}
        </ol>
        <div className="run-actions">
          <button className="primary-button" type="button" disabled={running} onClick={() => { void run() }}>{running ? 'Running real test...' : 'Run real protocol test'}</button>
          <button className="soft-button" type="button" disabled={step < steps.length} onClick={() => router.push('/evidence')}>Continue to evidence</button>
        </div>
        {summary ? <p className={summary.includes('failed') || summary.includes('No peer') ? 'status error' : 'status'}>{summary}</p> : null}
        {details.length > 0 ? (
          <div className="log-card">
            <h3>Protocol trace</h3>
            {details.map((item) => <p key={item}>{item}</p>)}
          </div>
        ) : null}
        {runtimeUrl ? <iframe ref={frameRef} className="protocol-frame" title="Nodex protocol runtime" src={runtimeUrl} /> : null}
      </section>
    </TesterLayout>
  )
}

export function EvidencePage() {
  const router = useRouter()
  const [result, setResult] = useState<BetaResult>('pass')
  const [topology, setTopology] = useState('lan-multi-machine')
  const [notes, setNotes] = useState('')
  const [status, setStatus] = useState('')

  async function send() {
    const auth = readAuth()
    const session = readSession()
    if (!auth || !session) {
      setStatus('Create a test room before sending evidence.')
      return
    }
    setStatus('Sending evidence...')
    try {
      const payload = {
        participantId: session.participantId,
        roomId: session.roomId,
        topologyLabel: topology,
        result,
        notes: notes.trim() || undefined,
        telemetry: readLogs(),
        storagePressure: { localLogEvents: readLogs().length },
        runtimeConfig: { nextSuite: true },
      }
      const saved = await submitEvidence(session.sessionToken, payload)
      addLog('Evidence saved.', 'info', { evidenceId: saved.evidenceId })
      await sendLog(auth.token, {
        participantId: session.participantId,
        roomId: session.roomId,
        level: 'info',
        message: 'Tester submitted evidence from Next beta suite.',
        details: buildLogBundle(auth, session),
      }).catch(() => undefined)
      router.push('/receipt')
    } catch (err) {
      setStatus((err as Error).message)
    }
  }

  function copyLogs() {
    void navigator.clipboard?.writeText(JSON.stringify(buildLogBundle(readAuth(), readSession()), null, 2))
    setStatus('Logs copied. If clipboard access is blocked, use Download logs.')
  }

  function downloadLogs() {
    const blob = new Blob([JSON.stringify(buildLogBundle(readAuth(), readSession()), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'nodex-beta-logs.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <TesterLayout current="evidence">
      <PageIntro eyebrow="Evidence" title="Send your result." body="Choose what happened. If unsure, choose partial and add a note." />
      <section className="evidence-grid">
        <div className="form-stack evidence-form">
          <label>Topology<select aria-label="Topology" value={topology} onChange={(e) => setTopology(e.target.value)}><option value="lan-multi-machine">LAN / same location</option><option value="wan-nat">WAN / NAT</option><option value="turn-relay">Forced TURN relay</option><option value="mobile">Mobile browser</option></select></label>
          <label>Result<select aria-label="Result" value={result} onChange={(e) => setResult(e.target.value as BetaResult)}><option value="pass">Pass</option><option value="partial">Partial</option><option value="fail">Fail</option><option value="not_measured">Not measured</option></select></label>
          <label>Notes<textarea aria-label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What did you see?" /></label>
          <button className="primary-button" type="button" onClick={send}>Send evidence</button>
        </div>
        <div className="log-card">
          <h3>Local log bundle</h3>
          <pre>{JSON.stringify(buildLogBundle(readAuth(), readSession()), null, 2)}</pre>
          <button className="soft-button" type="button" onClick={copyLogs}>Copy logs</button>
          <button className="soft-button" type="button" onClick={downloadLogs}>Download logs</button>
        </div>
      </section>
      <p className={status.includes('before') || status.includes('failed') ? 'status error' : 'status'}>{status}</p>
    </TesterLayout>
  )
}

export function ReceiptPage() {
  const [session, setSession] = useState<BetaSession | null>(null)
  useEffect(() => setSession(readSession()), [])
  return (
    <TesterLayout current="receipt">
      <PageIntro eyebrow="Complete" title="Evidence received." body="Your test is saved. You can close this page or wait for another run." />
      <section className="receipt-panel">
        <StatusCard label="Participant" value={session?.participantId ?? 'saved'} />
        <StatusCard label="Room" value={session?.roomId ?? 'saved'} />
        <StatusCard label="Ledger" value="ready for review" tone="ok" />
      </section>
    </TesterLayout>
  )
}

function StatusCard({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  return <div className={`status-card ${tone ?? ''}`}><span>{label}</span><strong>{value}</strong></div>
}

function buildLiveNodes(mode: RoomMode, open: boolean, session: BetaSession | null, selfName: string, onlinePeers: PresencePeer[]): LiveNode[] {
  const selfOnline = onlinePeers.some((peer) => samePresenceIdentity(peer, session, selfName))
  const selfState: LiveNodeState = !open ? 'offline' : selfOnline ? 'ready' : 'waiting'
  const others = onlinePeers.filter((peer) => !samePresenceIdentity(peer, session, selfName))
  const coordinator = others.find((peer) => peer.role === 'admin')
  const testerPeer = others.find((peer) => peer.role === 'tester')
  const base: LiveNode[] = [
    { id: 'self', label: selfName || 'You', role: session?.participantId ?? 'consumer', state: selfState, x: 18, y: 76 },
  ]
  if (mode !== 'solo') {
    base.push({ id: 'coordinator', label: coordinator?.name ?? 'Waiting coordinator', role: 'consumer', state: coordinator ? 'ready' : open ? 'waiting' : 'offline', x: 54, y: 46 })
  }
  if (mode === 'group') {
    base.push({ id: 'peer', label: testerPeer?.name ?? 'Waiting tester', role: 'consumer', state: testerPeer ? 'ready' : open ? 'waiting' : 'offline', x: 86, y: 76 })
  }
  return base
}

function roomStatus(mode: RoomMode, open: boolean, onlinePeers: PresencePeer[]): string {
  const hasCoordinator = onlinePeers.some((peer) => peer.role === 'admin')
  const testerCount = onlinePeers.filter((peer) => peer.role === 'tester').length
  if (!open) return mode === 'solo' ? 'not opened' : hasCoordinator ? 'waiting tester' : 'waiting coordinator'
  if (onlinePeers.length === 0) return 'checking presence'
  if (mode === 'solo') return 'browser visible'
  if (!hasCoordinator) return 'waiting coordinator'
  if (mode === 'duo' && testerCount < 1) return 'waiting tester'
  if (mode === 'group' && testerCount < 2) return 'waiting group'
  return 'ready to run'
}

function samePresenceIdentity(peer: PresencePeer, session: BetaSession | null, selfName: string): boolean {
  if (session?.participantId && peer.participantId === session.participantId) return true
  return Boolean(selfName.trim()) && peer.name.trim().toLowerCase() === selfName.trim().toLowerCase()
}

function roomTestUrl(baseUrl: string, roomId: string): string {
  try {
    const url = new URL(baseUrl)
    if (roomId) url.searchParams.set('nodexRoom', roomId)
    url.searchParams.set('nodexSignalingUrl', `${betaApiBase()}/api/signal`)
    return url.toString()
  } catch {
    return baseUrl
  }
}

async function collectBrowserDiagnostics(): Promise<BrowserDiagnostic[]> {
  const checks: BrowserDiagnostic[] = [
    {
      label: 'WebRTC',
      ok: typeof RTCPeerConnection !== 'undefined',
      detail: typeof RTCPeerConnection !== 'undefined' ? 'Available for real peer links.' : 'Not available in this browser.',
    },
    {
      label: 'Service worker',
      ok: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
      detail: typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? 'Supported.' : 'Not supported.',
    },
    {
      label: 'Cache storage',
      ok: typeof caches !== 'undefined',
      detail: typeof caches !== 'undefined' ? 'Available.' : 'Not available.',
    },
    {
      label: 'Network',
      ok: typeof navigator === 'undefined' ? true : navigator.onLine,
      detail: typeof navigator === 'undefined' || navigator.onLine ? 'Browser reports online.' : 'Browser reports offline.',
    },
  ]

  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate().catch(() => null)
    const quotaMb = estimate?.quota ? Math.round(estimate.quota / 1024 / 1024) : null
    checks.push({
      label: 'Browser storage',
      ok: Boolean(estimate?.quota),
      detail: quotaMb ? `${quotaMb} MB estimated quota.` : 'Storage estimate unavailable.',
    })
  } else {
    checks.push({ label: 'Browser storage', ok: false, detail: 'Storage estimate unavailable.' })
  }

  return checks
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(100)
  }
  throw new Error('runtime readiness timeout')
}

function buildRuntimeUrl(roomId: string, mode: string, signalingUrl: string, betaToken?: string): string {
  const url = new URL('/metrics.html', window.location.origin)
  url.searchParams.set('nodexRoom', roomId)
  url.searchParams.set('nodexTopology', `beta-${mode}`)
  url.searchParams.set('nodexSignalingUrl', signalingUrl)
  if (betaToken) url.searchParams.set('nodexBetaToken', betaToken)
  return url.toString()
}

async function waitForRuntimeFrame(
  ref: React.RefObject<HTMLIFrameElement | null>,
  expectedUrl: string,
): Promise<Window> {
  await waitForCondition(() => {
    const frameWindow = ref.current?.contentWindow
    return Boolean(frameWindow && frameWindow.location.href === expectedUrl && frameWindow.document.readyState !== 'loading')
  }, 8000)
  const frameWindow = ref.current?.contentWindow
  if (!frameWindow) throw new Error('protocol frame unavailable')
  return frameWindow
}

function connectedPeerCount(runtimeWindow: Window): number {
  const conns = (runtimeWindow as unknown as Record<string, unknown>)['__peerConnections'] as
    | Map<string, { state: string }>
    | undefined
  return conns ? [...conns.values()].filter((conn) => conn.state === 'connected').length : 0
}

function countMetrics(events: Array<{ type: string }>): { swCache: number; peerFetch: number; serverFallback: number; gossip: number } {
  return {
    swCache: events.filter((event) => event.type === 'sw-cache').length,
    peerFetch: events.filter((event) => event.type === 'peer-fetch').length,
    serverFallback: events.filter((event) => event.type === 'server-fallback').length,
    gossip: events.filter((event) => event.type === 'gossip-propagation').length,
  }
}

async function collectProtocolTelemetry(runtimeWindow: Window): Promise<unknown[]> {
  const fn = (runtimeWindow as unknown as Record<string, unknown>)['__nodexPeerTelemetry']
  if (typeof fn !== 'function') return []
  return await (fn as () => Promise<unknown[]>)()
}

function readP2PCapture(runtimeWindow: Window): unknown {
  const fn = (runtimeWindow as unknown as Record<string, unknown>)['__nodexLastP2PCapture']
  return typeof fn === 'function' ? (fn as () => unknown)() : null
}

function LiveMesh({ nodes, roomLabel }: { nodes: LiveNode[]; roomLabel: string }) {
  const readyNodes = nodes.filter((node) => node.state === 'ready')
  const links = nodes.flatMap((node, index) => nodes.slice(index + 1).map((target) => ({ from: node, to: target })))
  const firstConsumer = nodes[0]
  const originSeeded = firstConsumer?.state === 'ready'
  return (
    <div className="trace-console">
      <div className="trace-toolbar">
        <div>
          <span>Topology</span>
          <strong>{roomLabel}</strong>
        </div>
        <div>
          <span>Origin</span>
          <strong>{originSeeded ? 'seeded' : 'idle'}</strong>
        </div>
        <div>
          <span>Nodes</span>
          <strong>{readyNodes.length}/{nodes.length}</strong>
        </div>
      </div>
      <svg viewBox="0 0 100 100" role="img" aria-label="Room connection graph">
        <g className={`origin-node ${originSeeded ? 'active' : ''}`} transform="translate(50 12)">
          <title>Origin database</title>
          <rect x="-16" y="-6" width="32" height="12" rx="2" />
          <text y="1.5" textAnchor="middle">Origin DB</text>
        </g>
        {firstConsumer ? (
          <path
            d={`M 50 18 L 50 31 L ${firstConsumer.x} 31 L ${firstConsumer.x} ${firstConsumer.y}`}
            className={originSeeded ? 'origin-link active' : 'origin-link'}
          />
        ) : null}
        {links.map((link) => {
          const active = link.from.state === 'ready' && link.to.state === 'ready'
          const midY = Math.min(link.from.y, link.to.y) - 10
          return (
            <path
              key={`${link.from.id}-${link.to.id}`}
              d={`M ${link.from.x} ${link.from.y} L ${link.from.x} ${midY} L ${link.to.x} ${midY} L ${link.to.x} ${link.to.y}`}
              className={active ? 'mesh-link active' : 'mesh-link'}
            />
          )
        })}
        {nodes.map((node) => (
          <g key={node.id} className={`mesh-node ${node.state}`} transform={`translate(${node.x} ${node.y})`}>
            <title>{node.label}</title>
            <rect x="-12" y="-7" width="24" height="14" rx="2" />
            <text y="2" textAnchor="middle">{compactNodeLabel(node.label)}</text>
            <text y="13" textAnchor="middle" className="mesh-node-role">{node.state}</text>
          </g>
        ))}
      </svg>
      <div className="trace-footer">
        <span>Origin DB serves the first GET; consumers distribute after cache seed</span>
        <b>{readyNodes.length === nodes.length ? 'Data ready for peer distribution' : 'Waiting for visible nodes'}</b>
      </div>
    </div>
  )
}

function compactNodeLabel(label: string): string {
  const firstName = label.trim().split(/\s+/)[0] ?? label
  if (label.length > 14 && firstName.length <= 12) return firstName
  return label.length > 14 ? `${label.slice(0, 11)}...` : label
}
