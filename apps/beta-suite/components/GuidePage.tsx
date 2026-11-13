'use client'

import { useState } from 'react'
import Link from 'next/link'
import { betaApiBase } from '../lib/beta-api'

type Level = 'idle' | 'ok' | 'warn' | 'bad'
interface Check { label: string; level: Level; detail: string }

const STEPS: Array<{ title: string; body: string; note?: string }> = [
  { title: 'Both people: use a desktop Chrome or Edge window',
    body: 'Open the same https address on both computers. Keep the Nodex tab visible and the laptop awake for the whole run (about 6 minutes). A hidden or sleeping tab pauses the test.',
    note: 'Phones and Safari are fine for a second run, not the first.' },
  { title: 'Both people: run the preflight below',
    body: 'Press "Run checks". Browser support and server reachability must be green. Press "Check my connection" to see what kind of network path you have.',
    note: 'The connection check contacts a public STUN server (Google), which sees your public IP address. Nothing else is sent.' },
  { title: 'Owner: sign in with the admin invitation',
    body: 'Open the sign-in page, paste the admin token, and leave "Remember me" off unless this is your own computer.' },
  { title: 'Friend: sign in with the tester invitation',
    body: 'The owner sends this token privately (not in a group chat). It works for one person; do not forward it.' },
  { title: 'Owner: start a shared room',
    body: 'In Admin, open Runs, fill in a title, set the node count to 2, and press "Start simulated test". Join it as coordinator and keep that page open.' },
  { title: 'Friend: confirm the profile and pick the room',
    body: 'Setup, then Profile, then Room. Choose "Coordinator + tester", select the shared room the owner created, and press the join button.' },
  { title: 'Both: wait for two ready nodes, then run',
    body: 'Both names show as ready in the room. Press Run and follow the on-screen steps without closing the tab.',
    note: 'Do the first run with both of you on home networks. Repeat it once with the friend on a phone hotspot: that is the harder case.' },
  { title: 'Both: send evidence and note the result',
    body: 'Evidence, then Send. Receipt shows what was recorded. A pass needs: no read older than 6 seconds, no version going backwards, and a peer connection that actually carried data.' },
  { title: 'Owner: revoke the friend\'s token afterwards',
    body: 'Admin, then Tokens, then revoke. Evidence files hold no addresses or tokens, but the invitation should not outlive the test.' },
]

async function probe(path: string): Promise<Response> {
  return fetch(`${betaApiBase()}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(6000) })
}

function nonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(18)), b => b.toString(16).padStart(2, '0')).join('')
}

async function gatherCandidates(): Promise<Set<string>> {
  const found = new Set<string>()
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
  pc.createDataChannel('probe')
  pc.onicecandidate = event => { const m = event.candidate?.candidate.match(/ typ (host|srflx|relay)/); if (m) found.add(m[1]!) }
  await pc.setLocalDescription(await pc.createOffer())
  await new Promise<void>(resolve => {
    const done = () => resolve()
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') done() }
    setTimeout(done, 4000)
  })
  pc.close()
  return found
}

export function GuidePage() {
  const [checks, setChecks] = useState<Check[]>([])
  const [net, setNet] = useState<Check | null>(null)
  const [busy, setBusy] = useState(false)

  async function runChecks() {
    setBusy(true)
    const out: Check[] = []
    const push = (check: Check) => { out.push(check); setChecks([...out]) }
    const secure = window.isSecureContext
    push({ label: 'Secure page (https)', level: secure ? 'ok' : 'bad', detail: secure ? 'Yes' : 'Open the https address; the Service Worker and encryption need it.' })
    push({ label: 'Service Worker', level: 'serviceWorker' in navigator ? 'ok' : 'bad', detail: 'serviceWorker' in navigator ? 'Supported' : 'Not available in this browser or window.' })
    push({ label: 'WebRTC', level: typeof RTCPeerConnection === 'function' ? 'ok' : 'bad', detail: typeof RTCPeerConnection === 'function' ? 'Supported' : 'Peer connections are blocked or unsupported.' })
    push({ label: 'Web Crypto', level: crypto?.subtle ? 'ok' : 'bad', detail: crypto?.subtle ? 'Supported' : 'Unavailable.' })
    try {
      const health = await probe('/api/beta/health')
      push({ label: 'Server reachable', level: health.ok ? 'ok' : 'bad', detail: health.ok ? 'Beta API answered' : `Beta API returned ${health.status}` })
    } catch { push({ label: 'Server reachable', level: 'bad', detail: 'No answer in 6 seconds. Check your connection or a blocking extension.' }) }
    try {
      const time = await probe(`/api/time?nonce=${nonce()}`)
      push({ label: 'Signed clock', level: time.ok ? 'ok' : 'warn',
        detail: time.ok ? 'Available: the strict 6 second bound can be checked' : `Returned ${time.status}: the test falls back to a weaker clock and must be reported as such` })
    } catch { push({ label: 'Signed clock', level: 'warn', detail: 'Unreachable: the test falls back to a weaker clock and must be reported as such.' }) }
    setBusy(false)
  }

  async function checkConnection() {
    setBusy(true)
    setNet({ label: 'Connection path', level: 'idle', detail: 'Checking (up to 4 seconds)...' })
    try {
      const found = await gatherCandidates()
      if (found.has('srflx')) setNet({ label: 'Connection path', level: 'ok', detail: 'Direct connection is likely (public address found).' })
      else if (found.has('host')) setNet({ label: 'Connection path', level: 'warn', detail: 'Only local addresses found. A direct connection may fail; a relay would then be needed.' })
      else setNet({ label: 'Connection path', level: 'bad', detail: 'No usable candidates. A VPN, firewall or browser setting may be blocking WebRTC.' })
    } catch { setNet({ label: 'Connection path', level: 'bad', detail: 'The check could not run.' }) }
    setBusy(false)
  }

  const rows = net ? [...checks, net] : checks
  return (
    <>
      <header className="public-topbar">
        <Link className="suite-brand" href="/" aria-label="Nodex beta home">
          <span className="brand-mark image-mark" aria-hidden="true"><img src="/assets/nodex-x-emblem-clean.png" alt="" /></span>
          <span className="brand-wordmark"><span><strong>Node<span>x</span></strong><em>Beta</em></span><small>Validation suite</small></span>
        </Link>
      </header>
      <main className="guide-page">
        <p className="eyebrow">Two-person test</p>
        <h1>Test Nodex with a friend, step by step.</h1>
        <p>This checks two things on a real network: that nobody is ever shown data older than 6 seconds, and whether two browsers on different connections can actually exchange data. It does not measure cost savings.</p>

        <section className="guide-card" aria-labelledby="pre">
          <h2 id="pre">Preflight (both people)</h2>
          <button className="primary-button" type="button" onClick={runChecks} disabled={busy}>Run checks</button>{' '}
          <button className="soft-button" type="button" onClick={checkConnection} disabled={busy}>Check my connection</button>
          <ul className="check-list" role="status" aria-live="polite">
            {rows.map(row => (
              <li key={row.label}><span className={`check-dot ${row.level}`} aria-hidden="true" />
                <span><b>{row.label}:</b> {row.detail}</span></li>
            ))}
          </ul>
        </section>

        <section className="guide-card" aria-labelledby="steps">
          <h2 id="steps">The steps</h2>
          <ol className="guide-steps">
            {STEPS.map(step => (
              <li key={step.title}><b>{step.title}</b><br />{step.body}{step.note ? <em>{step.note}</em> : null}</li>
            ))}
          </ol>
        </section>

        <section className="guide-card" aria-labelledby="priv">
          <h2 id="priv">What each side can see</h2>
          <p>Each of you can see the other's public IP address while connected, and so can the signaling and STUN servers. Result files contain no addresses, tokens or response bodies. If that is not acceptable, do not run the test.</p>
        </section>

        <p><Link href="/">Back to sign in</Link></p>
      </main>
    </>
  )
}
