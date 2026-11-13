// Deterministic, seeded discrete-event simulator. Plain Node, no dependencies.
// One workload trace per (scenario, seed) is replayed against every arm, so arms are paired.
// This is a MODEL. It produces "Hypothesis"-grade evidence only (rigor standard section 4),
// never "Measured". See README.md for the list of simplifications.

export const ARMS = [
  'origin-only',    // every read hits the origin
  'browser-ttl',    // per-browser HTTP cache, max-age = delta, ETag revalidation (pilot arm B1)
  'cdn-ttl',        // edge cache TTL = delta, Age-aware browser cache, ETag (pilot arm B0, same delta)
  'cdn-purge',      // edge TTL = purgeTtlMs + purge on write (lossy), browser revalidates each read
  'p2p-gossip',     // ablation: peer cache + invalidation gossip, NO signed validity window
  'nodex-coupled',  // as coded today: proof signs iv+validatedAt per GET, raw client clock
  'nodex-detached', // proposed: payload fixed per version, small renewable proof gossiped, calibrated clock
]

export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

export function seedOf(...parts) { // FNV-1a
  let h = 0x811c9dc5
  for (const ch of parts.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}

class Heap { // min-heap on (t, seq); seq makes ties deterministic
  constructor() { this.a = []; this.seq = 0 }
  push(t, type, x, y, z) {
    const a = this.a, e = [t, this.seq++, type, x, y, z]
    let i = a.length; a.push(e)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p][0] < e[0] || (a[p][0] === e[0] && a[p][1] < e[1])) break
      a[i] = a[p]; i = p
    }
    a[i] = e
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop()
    if (a.length) {
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= a.length) break
        if (c + 1 < a.length && (a[c + 1][0] < a[c][0] || (a[c + 1][0] === a[c][0] && a[c + 1][1] < a[c][1]))) c++
        if (last[0] < a[c][0] || (last[0] === a[c][0] && last[1] < a[c][1])) break
        a[i] = a[c]; i = c
      }
      a[i] = last
    }
    return top
  }
  get size() { return this.a.length }
}

/** Workload shared by all arms: sessions (churn), reads, writes, clocks, adversaries. */
export function buildTrace(p, seed) {
  const r = mulberry32(seedOf('trace', seed))
  const D = p.durationMs
  const exp = mean => -Math.log(1 - r()) * mean
  const w = Array.from({ length: p.keys }, (_, i) => 1 / (i + 1) ** p.zipf)
  const total = w.reduce((a, b) => a + b, 0)
  const pickKey = () => { let u = r() * total; for (let i = 0; i < w.length; i++) { u -= w[i]; if (u <= 0) return i } return w.length - 1 }

  const writes = []
  for (let k = 0; k < p.keys; k++) for (let t = exp(p.writeMeanMs); t < D; t += exp(p.writeMeanMs)) writes.push([t, k])
  writes.sort((a, b) => a[0] - b[0] || a[1] - b[1])

  const sessions = []
  for (let slot = 0; slot < p.readers; slot++) {
    let t = r() * 2000
    while (t < D) {
      const end = Math.min(D, t + Math.max(1000, exp(p.sessionMeanMs)))
      const bad = r() < p.badClockFrac
      const s = {
        id: sessions.length, key: pickKey(), pop: Math.floor(r() * p.pops), start: t, end,
        off: bad ? (r() < 0.5 ? -p.badClockMs : p.badClockMs) : (r() * 2 - 1) * p.skewMs,
        adv: r() < p.adversaryFrac, theta: p.renewMinMs + r() * (p.renewMaxMs - p.renewMinMs), reads: [],
      }
      for (let rt = t + r() * p.readMeanMs; rt < end; rt += p.readMeanMs * (0.75 + 0.5 * r())) s.reads.push(rt)
      sessions.push(s)
      t = end + r() * 500
    }
  }
  return { writes, sessions }
}

const JOIN = 0, LEAVE = 1, READ = 2, WRITE = 3, INVAL = 4, PURGE = 5, LINK = 6, PROOF = 7

/**
 * opt.calibrate  override clock calibration (default: only nodex-detached calibrates)
 * opt.checkProof mutation hook: false disables the validity-window check (oracle must then report violations)
 */
export function runArm(arm, p, trace, seed, opt = {}) {
  const rnd = mulberry32(seedOf('arm', arm, seed))
  const u = (lo, hi) => lo + rnd() * (hi - lo)
  const P2P = arm === 'p2p-gossip' || arm === 'nodex-coupled' || arm === 'nodex-detached'
  const calibrate = opt.calibrate ?? (arm === 'nodex-detached')
  const checkProof = opt.checkProof ?? true
  const DELTA = p.deltaMs, BOUND = p.deltaMs + p.epsMs
  const B = p.payloadBytes, H = p.httpOverheadBytes, PB = p.proofBytes, MO = p.peerMsgBytes

  const head = new Int32Array(p.keys).fill(1)
  const commits = Array.from({ length: p.keys }, () => [0, 0]) // commits[k][v] = commit time of version v
  const live = Array.from({ length: p.keys }, () => [])
  const edge = Array.from({ length: p.pops * p.keys }, () => null)
  const st = new Array(trace.sessions.length)
  const m = {
    reads: 0, pathLocal: 0, pathReval: 0, pathPeer: 0, pathEdge: 0, pathOrigin: 0,
    originReqs: 0, edgeReqs: 0, originBytes: 0, edgeBytes: 0, peerPayloadBytes: 0, peerControlBytes: 0,
    proofRenewals: 0, peerAttempts: 0, peerRejects: 0, staleReads: 0, violations: 0, monoViolations: 0,
    maxStaleMs: 0, sumStaleMs: 0, signalingPolls: 0, readerMs: 0,
  }
  const lat = [], stale = []
  const q = new Heap()
  for (const s of trace.sessions) { q.push(s.start, JOIN, s.id); q.push(s.end, LEAVE, s.id) }
  for (const [t, k] of trace.writes) q.push(t, WRITE, k)

  const jitter = base => base * (0.8 + 0.8 * rnd())
  const xfer = (bytes, bps) => bytes / bps * 1000
  const latLocal = () => jitter(1)
  const latEdge = bytes => jitter(p.edgeRttMs) + xfer(bytes, p.infraBps)
  const latOrigin = bytes => jitter(p.originRttMs) + xfer(bytes, p.infraBps)
  const latPeer = bytes => jitter(p.peerRttMs) + xfer(bytes, p.peerBps)
  const clock = (x, t) => t + (calibrate && x.cal ? x.calErr : x.s.off)
  const setCal = x => { if (calibrate && !x.cal) { x.cal = true; x.calErr = u(-p.calErrMs, p.calErrMs) } }
  const liveNbrs = x => { x.nbrs = x.nbrs.filter(n => n.alive); return x.nbrs }
  const pick = arr => arr[Math.floor(rnd() * arr.length)]
  // Worst-case replay adversary: remembers everything it saw and serves the stalest item the victim would admit.
  const remember = (x, e) => { if (x.s.adv && e) { x.hist.push(e); if (x.hist.length > 256) x.hist.shift() } }
  const stalest = (n, admit) => n.hist.find(admit) ?? null
  const validWindow = (e, now) => !checkProof || (e.validUntil > now && e.validatedAt <= now + 1000) // publisher-proof.ts:80

  function tryLink(x, t) {
    const pool = live[x.s.key]
    if (pool.length < 2) return
    const c = pick(pool)
    if (c === x || x.nbrs.includes(c)) return
    x.pending++
    q.push(t + u(p.linkSetupMinMs, p.linkSetupMaxMs), LINK, x, c, rnd() < p.directProb)
  }
  function flood(x, proof, from, t) {
    for (const n of liveNbrs(x)) {
      if (n === from) continue
      m.peerControlBytes += PB + MO
      q.push(t + u(20, 80), PROOF, n, proof, x)
    }
  }
  function originProof(x, t) {
    m.originReqs++; m.originBytes += PB + H
    setCal(x)
    const k = x.s.key
    x.proof = { v: head[k], validatedAt: t, validUntil: t + DELTA }
    remember(x, x.proof)
    if (head[k] > x.barrier) x.barrier = head[k]
    flood(x, x.proof, null, t)
  }
  function edgeFetch(x, t, ttl) { // returns edge entry, refreshing from origin when expired
    const i = x.s.pop * p.keys + x.s.key, h = head[x.s.key]
    let e = edge[i]
    if (!e || t - e.fetchedAt >= ttl) {
      if (e && rnd() < p.edgeStickProb) e.fetchedAt = t // fault injection: stale-if-error / failed revalidation
      else {
        m.originReqs++; m.originBytes += e && e.v === h ? H : B + H
        e = edge[i] = { v: h, fetchedAt: t, miss: true }
      }
    }
    return e
  }

  function read(x, t) {
    const k = x.s.key, h = head[k]
    let v, path, l = 0
    if (arm === 'origin-only') {
      m.originReqs++; m.originBytes += B + H; v = h; path = 'Origin'; l = latOrigin(B)
    } else if (arm === 'browser-ttl') {
      if (x.local && t < x.local.exp) { v = x.local.v; path = 'Local'; l = latLocal() }
      else {
        m.originReqs++
        if (x.local && x.local.v === h) { m.originBytes += H; path = 'Reval'; l = latOrigin(0) }
        else { m.originBytes += B + H; path = 'Origin'; l = latOrigin(B) }
        x.local = { v: h, exp: t + DELTA }; v = h
      }
    } else if (arm === 'cdn-ttl' || arm === 'cdn-purge') {
      const ttl = arm === 'cdn-ttl' ? DELTA : p.purgeTtlMs
      if (arm === 'cdn-ttl' && x.local && t < x.local.exp) { v = x.local.v; path = 'Local'; l = latLocal() }
      else {
        m.edgeReqs++
        const e = edgeFetch(x, t, ttl)
        const missPenalty = e.miss ? jitter(p.originRttMs - p.edgeRttMs) : 0
        e.miss = false
        if (x.local && x.local.v === e.v) { m.edgeBytes += H; path = 'Reval'; l = latEdge(0) + missPenalty }
        else { m.edgeBytes += B + H; path = 'Edge'; l = latEdge(B) + missPenalty }
        x.local = { v: e.v, exp: e.fetchedAt + DELTA } // Age-aware: browser + edge never exceed delta together
        v = e.v
      }
    } else if (arm === 'p2p-gossip' || arm === 'nodex-coupled') {
      const gossip = arm === 'p2p-gossip'
      const now = clock(x, t)
      const admit = e => e.v >= x.barrier && (gossip ? t - e.at <= p.gossipTtlMs : validWindow(e, now))
      const needCal = calibrate && !x.cal
      if (!needCal && x.entry && admit(x.entry)) { v = x.entry.v; path = 'Local'; l = latLocal() }
      else {
        if (!needCal) {
          const cands = liveNbrs(x).filter(n => n.s.adv || (n.entry && n.entry.v >= x.barrier &&
            (gossip ? t - n.entry.at < p.gossipTtlMs - 200 : n.entry.validUntil > t + 200)))
          if (cands.length) {
            const n = pick(cands)
            m.peerAttempts++
            // Without a signed window the adversary can also relabel the timestamp of an old copy.
            const got = !n.s.adv ? n.entry
              : gossip ? (e => e && { v: e.v, at: t })(stalest(n, e => e.v >= x.barrier)) : stalest(n, admit)
            if (got && admit(got)) {
              x.entry = got; v = got.v; path = 'Peer'; l = latPeer(B)
              m.peerPayloadBytes += B + PB + MO
            } else { m.peerRejects++; l += p.peerDeadlineMs }
          }
        }
        if (!path) {
          m.originReqs++; m.originBytes += B + PB + H; setCal(x)
          x.entry = gossip ? { v: h, at: t } : { v: h, validatedAt: t, validUntil: t + DELTA }
          v = h; path = 'Origin'; l += latOrigin(B)
        }
        remember(x, x.entry)
      }
    } else { // nodex-detached
      let fetchedProof = false
      let fromOrigin = false
      if (calibrate && !x.cal) { originProof(x, t); l += latOrigin(0); fetchedProof = true; fromOrigin = true }
      let now = clock(x, t)
      const ok = e => e && e.v >= x.barrier && validWindow(e, now)
      if (!ok(x.proof)) {
        const cands = liveNbrs(x).filter(n => n.s.adv || (n.proof && n.proof.v >= x.barrier && n.proof.validUntil > t + 200))
        if (cands.length) {
          const n = pick(cands)
          m.peerAttempts++; m.peerControlBytes += PB + MO
          const got = n.s.adv ? stalest(n, ok) : n.proof
          if (ok(got)) { x.proof = got; l += latPeer(0); fetchedProof = true }
          else { m.peerRejects++; l += p.peerDeadlineMs }
        }
        if (!ok(x.proof)) { originProof(x, t); l += latOrigin(0); fetchedProof = true; fromOrigin = true; now = clock(x, t) }
      }
      v = x.proof.v
      if (x.payloadV === v) { path = fetchedProof ? 'Reval' : 'Local'; l += fetchedProof ? 0 : latLocal() }
      else {
        const cands = liveNbrs(x).filter(n => n.s.adv || n.payloadV === v)
        if (fromOrigin && !cands.length) {
          // Cold start with no advertising peer: the payload rides the same origin response as the proof.
          m.originBytes += B; x.payloadV = v; path = 'Origin'; l += xfer(B, p.infraBps)
        } else if (cands.length) {
          const n = pick(cands)
          m.peerAttempts++
          if (!n.s.adv) { m.peerPayloadBytes += B + MO; x.payloadV = v; path = 'Peer'; l += latPeer(B) }
          else { m.peerRejects++; l += p.peerDeadlineMs } // digest mismatch or withheld
        }
        if (!path) { m.originReqs++; m.originBytes += B + H; x.payloadV = v; path = 'Origin'; l += latOrigin(B) }
      }
      // Background renewal: the first reader whose jittered threshold fires renews for its whole component.
      // Early renewals are thinned by the room size (known from signaling presence) so origin proof work
      // does not grow with the audience; below renewMinMs every reader renews (deadline).
      const left = x.proof.validUntil - now
      if (left < p.renewMinMs || (left < x.s.theta && rnd() < p.renewTarget / live[k].length)) { m.proofRenewals++; originProof(x, t) }
    }

    if (v > x.barrier) x.barrier = v
    const age = v < h ? t - commits[k][v + 1] : 0 // time since the returned version was superseded
    m.reads++; m['path' + path]++
    if (age > 0) m.staleReads++
    if (age > BOUND) m.violations++
    if (age > m.maxStaleMs) m.maxStaleMs = age
    m.sumStaleMs += age
    if (v < x.lastV) m.monoViolations++; else x.lastV = v
    lat.push(l); stale.push(age)
  }

  while (q.size) {
    const [t, , type, a, b, c] = q.pop()
    if (type === READ) {
      const x = st[a]
      if (!x.alive) continue
      if (P2P && x.pending === 0 && liveNbrs(x).length < p.fanout && t - x.lastTry > 5000) { x.lastTry = t; tryLink(x, t) }
      read(x, t)
      if (++x.ri < x.s.reads.length) q.push(x.s.reads[x.ri], READ, a)
    } else if (type === JOIN) {
      const s = trace.sessions[a]
      const x = st[a] = { s, alive: true, nbrs: [], pending: 0, lastTry: t, barrier: 0, lastV: 0, ri: 0,
        entry: null, hist: [], proof: null, payloadV: 0, local: null, cal: false, calErr: 0 }
      live[s.key].push(x)
      if (P2P) for (let i = 0; i < p.fanout; i++) tryLink(x, t)
      if (s.reads.length) q.push(s.reads[0], READ, a)
    } else if (type === LEAVE) {
      const x = st[a]
      x.alive = false
      const pool = live[x.s.key]; pool.splice(pool.indexOf(x), 1)
      const life = x.s.end - x.s.start
      m.readerMs += life
      if (P2P) m.signalingPolls += Math.min(life, p.pollDiscoveryWindowMs) / p.pollDiscoveryMs +
        Math.max(0, life - p.pollDiscoveryWindowMs) / p.pollSteadyMs
    } else if (type === WRITE) {
      const v = ++head[a]
      commits[a][v] = t
      if (P2P) for (const x of live[a]) if (rnd() >= p.invalidationLoss) q.push(t + u(p.invalMinMs, p.invalMaxMs), INVAL, x, v)
      if (arm === 'cdn-purge') for (let pop = 0; pop < p.pops; pop++) if (rnd() >= p.purgeLoss) q.push(t + u(50, 300), PURGE, pop * p.keys + a)
    } else if (type === INVAL) {
      if (a.alive && b > a.barrier) a.barrier = b
    } else if (type === PURGE) {
      edge[a] = null
    } else if (type === LINK) {
      a.pending--
      if (c && a.alive && b.alive && !a.nbrs.includes(b) && a.nbrs.length < 2 * p.fanout && b.nbrs.length < 2 * p.fanout) {
        a.nbrs.push(b); b.nbrs.push(a)
      }
    } else if (type === PROOF) { // a = receiver, b = proof, c = sender
      if (!a.alive) continue
      if (a.s.adv) { remember(a, b); continue } // adversaries record and withhold
      if (calibrate && !a.cal) continue
      if (a.proof && b.validatedAt <= a.proof.validatedAt + p.proofDedupMs) continue
      const now = clock(a, t)
      if (b.v < a.barrier || !validWindow(b, now)) continue
      a.proof = b
      if (b.v > a.barrier) a.barrier = b.v // a newer proof doubles as the invalidation of older versions
      flood(a, b, c, t)
    }
  }

  lat.sort((x, y) => x - y); stale.sort((x, y) => x - y)
  const pct = (arr, f) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * f))] : 0
  const hours = m.readerMs / 3.6e6
  return {
    ...m, readerHours: hours, billedBytes: m.originBytes + m.edgeBytes,
    latP50: pct(lat, 0.5), latP95: pct(lat, 0.95), latP99: pct(lat, 0.99), staleP99Ms: pct(stale, 0.99),
  }
}

/** Hypothetical unit prices only. Replace with the customer's invoice before quoting any number. */
export function cost(row, prices) {
  return row.billedBytes / 2 ** 30 * prices.egressPerGiB +
    (row.edgeReqs * prices.edgeReqPerM + row.originReqs * prices.originReqPerM + row.signalingPolls * prices.pollPerM) / 1e6
}
