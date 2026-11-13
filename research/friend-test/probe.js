/* Steer friend-test probe. Classic script, no dependencies, no network calls except same-origin
 * /api/time and the product key under test. It never reads or stores IP addresses, the invitation
 * token, or the response body.
 *
 * Two ways to run it:
 *   1. friend.html (recommended): the page loads this file and drives it.
 *   2. Console fallback on /metrics.html (no production change needed): paste this file, then
 *        SteerProbe.run({ role: 'A', room: 'r1', key: '/api/products/friend-r1' }).then(SteerProbe.download)
 *
 * What the page can and cannot see (verified against src/sw/sw.ts:147-156 and :835-837): the decoded
 * response exposes X-Nodex-Seq, X-Nodex-Source, X-Nodex-Request-Id and X-Nodex-Consistency only. It does
 * NOT expose the proof's validatedAt nor whether a renewal came from a peer or from origin. Staleness is
 * therefore judged offline by analyze.mjs against the writer log, and peer-proof provenance needs either
 * the Service Worker request log (owner-observe.mjs) or a future X-Nodex-Renewal header, which this
 * probe already records when present.
 */
(function (root) {
  'use strict'
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  // Monotonic local epoch: immune to wall-clock steps during the run.
  const localNow = () => performance.timeOrigin + performance.now()
  const round1 = value => Math.round(value * 10) / 10

  function nonce() { // 24 url-safe chars, matches TIME_NONCE_PATTERN /^[A-Za-z0-9_-]{16,64}$/
    const bytes = crypto.getRandomValues(new Uint8Array(18))
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  /** Offset of the publisher clock against localNow(), from the lowest-RTT sample. */
  async function syncClock(samples) {
    let best = null
    const rtts = []
    for (let i = 0; i < samples; i++) {
      try {
        const sent = localNow()
        const response = await fetch('/api/time?nonce=' + nonce(), { cache: 'no-store' })
        const body = await response.json()
        const rtt = localNow() - sent
        if (response.ok && Number.isSafeInteger(body.serverMs)) {
          rtts.push(round1(rtt))
          if (!best || rtt < best.rttMs) best = { offsetMs: body.serverMs - (sent + rtt / 2), rttMs: rtt }
        }
      } catch { /* A failed sample is simply not counted. */ }
      await sleep(250)
    }
    if (!best) return { ok: false, offsetMs: 0, uncertaintyMs: Infinity, rttMs: null, rtts }
    return { ok: true, offsetMs: Math.round(best.offsetMs), uncertaintyMs: Math.ceil(best.rttMs / 2), rttMs: round1(best.rttMs), rtts }
  }

  function coarseAgent() { // browser family and major version only
    const data = navigator.userAgentData
    if (data && data.brands) {
      const brand = data.brands.find(entry => !/not.?a.?brand/i.test(entry.brand) && entry.brand !== 'Chromium') || data.brands[0]
      return { browser: brand ? brand.brand + ' ' + brand.version : 'unknown', platform: data.platform || 'unknown', mobile: !!data.mobile }
    }
    const ua = navigator.userAgent
    const match = ua.match(/(Firefox|Edg|Chrome|Version)\/(\d+)/)
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown'
    return { browser: match ? (match[1] === 'Version' ? 'Safari' : match[1]) + ' ' + match[2] : 'unknown', platform: os, mobile: /Mobi/.test(ua) }
  }

  const shortId = value => typeof value === 'string' ? value.slice(0, 6) : 'unknown'

  /** Candidate types, RTT and setup timings only. The runtime's sample carries no addresses
   *  (src/p2p/p2p-manager.ts:267-291); this whitelist keeps it that way if the runtime changes. */
  async function sampleTelemetry(rt, clock) {
    if (typeof rt.__nodexPeerTelemetry !== 'function') return []
    try {
      const samples = await rt.__nodexPeerTelemetry()
      return samples.map(sample => ({
        ts: Math.round(localNow() + clock.offsetMs), peer: shortId(sample.peer_id),
        type: sample.selected_candidate_type, local: sample.local_candidate_type, remote: sample.remote_candidate_type,
        state: sample.connection_state, ice: sample.ice_connection_state, channel: sample.data_channel_state,
        rttMs: sample.current_round_trip_time_ms, dcOpenMs: sample.dc_open_latency_ms, iceGatherMs: sample.ice_gather_duration_ms,
        bytesSent: sample.bytes_sent, bytesReceived: sample.bytes_received,
      }))
    } catch { return [] }
  }

  const connectedPeers = rt => {
    try { return [...(rt.__peerConnections ? rt.__peerConnections.values() : [])].filter(peer => peer.state === 'connected').length }
    catch { return 0 }
  }

  /**
   * opts: role ('A'|'B'), room, key (pathname), secs (default 360), forcedSecs (default 60),
   *       intervalMs (default 1000), rt (runtime window, default window), onEvent(name, data).
   */
  async function run(opts) {
    const rt = opts.rt || root
    const emit = (name, data) => { try { opts.onEvent && opts.onEvent(name, data) } catch { /* UI errors never stop the run. */ } }
    const secs = opts.secs || 360
    const forcedSecs = Math.min(opts.forcedSecs === undefined ? 60 : opts.forcedSecs, secs)
    const intervalMs = opts.intervalMs || 1000
    const result = {
      schema: 'steer-friend-probe/1', runId: crypto.randomUUID(), role: opts.role || 'A', room: opts.room || 'unknown',
      key: opts.key, plan: { secs, forcedSecs, intervalMs }, agent: coarseAgent(), secureContext: root.isSecureContext,
      clock: {}, mesh: { readyMs: null, connectedMs: null, meshWaitTimedOut: false }, telemetry: [], reads: [], visibility: [],
      runtime: {}, control: null, startedTs: 0, endedTs: 0, aborted: false,
    }
    const onVisibility = () => result.visibility.push({ tl: Math.round(localNow()), state: document.visibilityState })
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()

    emit('phase', { phase: 'clock' })
    const clock = await syncClock(5)
    result.clock.start = clock
    const toServer = local => Math.round(local + clock.offsetMs)
    const began = localNow()
    result.startedTs = toServer(began)
    emit('clock', clock)

    // Mesh: runtime ready, then at least one connected DataChannel. Idle signaling polls every 15 s
    // (OPERATIONS.md:43), so this can legitimately take tens of seconds.
    emit('phase', { phase: 'mesh' })
    const meshDeadline = began + (opts.meshWaitMs || 60000)
    while (localNow() < meshDeadline) {
      if (result.mesh.readyMs === null && rt.__peerManagerReady) result.mesh.readyMs = Math.round(localNow() - began)
      if (connectedPeers(rt) > 0) { result.mesh.connectedMs = Math.round(localNow() - began); break }
      emit('mesh-wait', { elapsedMs: Math.round(localNow() - began), ready: !!rt.__peerManagerReady })
      await sleep(500)
    }
    result.mesh.meshWaitTimedOut = result.mesh.connectedMs === null
    result.mesh.connectedTs = result.mesh.connectedMs === null ? null : toServer(began + result.mesh.connectedMs)
    result.telemetry.push(...await sampleTelemetry(rt, clock))
    emit('mesh', { ...result.mesh, telemetry: result.telemetry })
    try {
      const config = typeof rt.__nodexRuntimeConfig === 'function' ? rt.__nodexRuntimeConfig() : {}
      for (const name of ['iceServerCount', 'iceTransportPolicy', 'forceRelay']) if (name in config) result.runtime[name] = config[name]
    } catch { /* optional */ }

    // Read loop. Sequential, so per-reader order is unambiguous for the rollback check.
    emit('phase', { phase: 'reads' })
    const loopStart = localNow()
    const ticks = Math.floor(secs * 1000 / intervalMs)
    const forcedFrom = Math.floor((secs - forcedSecs) * 1000 / intervalMs)
    let highest = 0, nextTelemetry = loopStart + 15000, lateJoinLogged = result.mesh.connectedMs !== null
    for (let i = 0; i < ticks && !result.aborted; i++) {
      const due = loopStart + i * intervalMs + (Math.random() - 0.5) * 300
      const wait = due - localNow()
      if (wait > 0) await sleep(wait)
      else if (wait < -intervalMs) continue // fell behind (throttled tab): skip, never burst
      // In the last minute every fifth read is peer-only (existing X-Nodex-Read-Mode hook, sw.ts:856-872):
      // it measures whether a WAN peer answers inside the worker's peer deadline.
      const forced = i >= forcedFrom && (i - forcedFrom) % 5 === 0
      const started = localNow()
      const read = { i, tl: Math.round(started), ts: toServer(started), forced, hidden: document.visibilityState !== 'visible' }
      try {
        const response = await fetch(opts.key, forced ? { headers: { 'X-Nodex-Read-Mode': 'peer' } } : undefined)
        const body = await response.text()
        read.ms = round1(localNow() - started)
        read.status = response.status
        read.source = response.headers.get('X-Nodex-Source') || 'none'
        read.seq = Number(response.headers.get('X-Nodex-Seq')) || 0
        const renewal = response.headers.get('X-Nodex-Renewal') // not emitted today; see PORT-NOTES in STEER.md
        if (renewal) read.renewal = renewal
        read.bytes = body.length
        read.minVersion = Number(response.headers.get('X-Nodex-Min-Version')) || undefined
        try { read.n = JSON.parse(body).n } catch { /* body is opaque on error responses */ }
      } catch (error) {
        read.ms = round1(localNow() - started); read.status = 0; read.source = 'error'; read.err = String(error && error.name)
      }
      if (read.status === 200 && read.seq > 0) {
        if (read.seq < highest) read.rollback = highest
        highest = Math.max(highest, read.seq)
      }
      result.reads.push(read)
      emit('read', read)
      if (!lateJoinLogged && connectedPeers(rt) > 0) {
        lateJoinLogged = true
        result.mesh.connectedMs = Math.round(localNow() - began)
        result.mesh.connectedTs = toServer(localNow())
        result.telemetry.push(...await sampleTelemetry(rt, clock))
        emit('mesh', { ...result.mesh, telemetry: result.telemetry })
      }
      if (localNow() >= nextTelemetry) {
        nextTelemetry += 15000
        const samples = await sampleTelemetry(rt, clock)
        result.telemetry.push(...samples)
        emit('telemetry', samples)
      }
    }

    emit('phase', { phase: 'finish' })
    result.telemetry.push(...await sampleTelemetry(rt, clock))
    result.clock.end = await syncClock(2)
    result.endedTs = toServer(localNow())
    try { // application-body control bytes observed by the page (signaling, key, TURN credentials)
      const snapshot = typeof rt.__nodexControlMeter === 'function' ? rt.__nodexControlMeter(Math.round(began - 60000)) : null
      if (snapshot) result.control = {
        scope: snapshot.scope, discarded: snapshot.discarded, requests: snapshot.observations.length,
        requestBytes: snapshot.observations.reduce((sum, entry) => sum + entry.requestBytes, 0),
        responseBytes: snapshot.observations.reduce((sum, entry) => sum + entry.responseBytes, 0),
      }
    } catch { /* optional */ }
    document.removeEventListener('visibilitychange', onVisibility)
    emit('done', result)

    // Tail: keep holding fresh copies for the other side's last minute, untimed and unrecorded.
    if (opts.tailSecs) void (async () => {
      const until = localNow() + opts.tailSecs * 1000
      while (localNow() < until) { try { await (await fetch(opts.key)).text() } catch { /* ignore */ } await sleep(2000) }
      emit('tail-end', {})
    })()
    return result
  }

  function download(result) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(result)], { type: 'application/json' }))
    const link = Object.assign(document.createElement('a'), { href: url, download: 'steer-' + result.room + '-' + result.role + '.json' })
    document.body.appendChild(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    return result
  }

  root.SteerProbe = { run, download, syncClock }
})(typeof window !== 'undefined' ? window : globalThis)
