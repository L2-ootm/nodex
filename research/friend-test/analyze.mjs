// Verdict for one friend-test run against prereg-friend.json.
//
//   node analyze.mjs --writer writer-r1.jsonl --a steer-r1-A.json --b steer-r1-B.json [--sw-b sw-r1-B.jsonl] [--sw-a ...] [--json verdict.json]
//
// Exit code: 0 pass, 1 fail (a safety or feasibility hypothesis failed), 2 void or unusable input.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const quantile = (values, q) => { if (!values.length) return null; const s = [...values].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] }
const share = (part, whole) => whole > 0 ? part / whole : null
const pct = value => value === null ? 'n/a' : (value * 100).toFixed(1) + ' %'

export function loadWriter(text) {
  const entries = text.split('\n').filter(Boolean).map(line => JSON.parse(line))
  const clocks = entries.filter(entry => entry.type === 'clock')
  const acks = entries.filter(entry => entry.type === 'write' && entry.ok).map(entry => ({ version: entry.version, ackTs: entry.ackTs, sendTs: entry.sendTs }))
    .sort((x, y) => x.version - y.version)
  return { acks, uncertaintyMs: Math.max(0, ...clocks.map(clock => clock.uncertaintyMs ?? 0)), key: clocks[0]?.key,
    failedWrites: entries.filter(entry => entry.type === 'write' && !entry.ok).length }
}

/** Peer-proof provenance for one reader. Exact when the worker emits X-Nodex-Renewal; otherwise inferred
 *  from the Service Worker request log: a cache read more than 5.5 s after this reader last obtained
 *  anything from origin for the key can only have been admitted under a proof supplied by a peer. */
function peerProofs(reader, swLog) {
  const organic = reader.reads.filter(read => !read.forced && read.status === 200)
  if (organic.some(read => read.renewal)) {
    const peer = organic.filter(read => read.renewal === 'peer'), origin = organic.filter(read => read.renewal === 'origin')
    return { method: 'header', peer: peer.length, origin: origin.length, firstPeerTs: peer[0]?.ts ?? null }
  }
  if (!swLog) return { method: 'not-measured' }
  const touches = swLog.filter(entry => entry.path === reader.key || entry.path === reader.key + '/proof').map(entry => entry.t).sort((x, y) => x - y)
  const originProofs = swLog.filter(entry => entry.path === reader.key + '/proof').length
  const acquired = new Map() // version -> local time this reader first held it
  let peer = 0, lastCounted = -Infinity, firstPeerTs = null
  for (const read of reader.reads) {
    if (read.status !== 200) continue
    if (!acquired.has(read.seq)) acquired.set(read.seq, read.tl)
    if (read.forced || read.source !== 'sw-cache') continue
    const pastWindow = read.tl - acquired.get(read.seq) > 5500
    const originTouched = touches.some(t => t >= read.tl - 5500 && t <= read.tl + (read.ms ?? 0) + 100)
    const peerFetched = reader.reads.some(other => other.source === 'peer-fetch' && other.tl >= read.tl - 5500 && other.tl < read.tl)
    if (pastWindow && !originTouched && !peerFetched && read.tl - lastCounted >= 4000) { // one event per proof window
      peer++; lastCounted = read.tl; firstPeerTs ??= read.ts
    }
  }
  return { method: 'sw-log', peer, origin: originProofs, firstPeerTs }
}

export function analyzeReader(reader, writer, prereg, swLog) {
  const bound = prereg.bound.deltaMs + prereg.bound.epsilonMs
  const readerU = Math.max(reader.clock?.start?.uncertaintyMs ?? Infinity, reader.clock?.end?.ok ? reader.clock.end.uncertaintyMs : 0)
  const slack = readerU + writer.uncertaintyMs + prereg.bound.guardMs
  const ok = reader.reads.filter(read => read.status === 200 && read.seq > 0)
  const staleness = [], violations = [], rollbacks = []
  let highest = 0
  for (const read of ok) {
    const next = writer.acks.find(ack => ack.version > read.seq) // lowest acknowledged version above the one served
    const stale = next && next.ackTs < read.ts ? read.ts - next.ackTs : 0
    staleness.push(stale)
    if (stale > bound + slack) violations.push({ i: read.i, seq: read.seq, staleMs: stale, source: read.source, supersededBy: next.version })
    if (read.seq < highest) rollbacks.push({ i: read.i, seq: read.seq, after: highest, source: read.source })
    highest = Math.max(highest, read.seq)
  }
  const organic = reader.reads.filter(read => !read.forced)
  const organicOk = organic.filter(read => read.status === 200)
  const payload = organicOk.filter(read => read.source === 'peer-fetch' || read.source === 'server-fallback')
  const bytes = source => payload.filter(read => read.source === source).reduce((sum, read) => sum + (read.bytes ?? 0), 0)
  const forced = reader.reads.filter(read => read.forced)
  const connected = reader.telemetry.filter(sample => sample.state === 'connected' || sample.channel === 'open')
  const types = [...new Set(connected.map(sample => sample.type).filter(Boolean))]
  const rtts = connected.map(sample => sample.rttMs).filter(Number.isFinite)
  const drift = reader.clock?.end?.ok ? Math.abs(reader.clock.end.offsetMs - reader.clock.start.offsetMs) : null
  return {
    role: reader.role, agent: reader.agent, reads: reader.reads.length, okReads: ok.length,
    failedShare: share(reader.reads.filter(read => read.status !== 200).length, reader.reads.length),
    hiddenShare: share(reader.reads.filter(read => read.hidden).length, reader.reads.length),
    clockUncertaintyMs: readerU, clockDriftMs: drift, slackMs: slack,
    maxStaleMs: Math.max(0, ...staleness), p95StaleMs: quantile(staleness, 0.95), violations, rollbacks,
    sources: Object.fromEntries(['sw-cache', 'peer-fetch', 'server-fallback'].map(source => [source, organicOk.filter(read => read.source === source).length])),
    peerPayloadBytes: bytes('peer-fetch'), originPayloadBytes: bytes('server-fallback'),
    forcedTrials: forced.length, forcedPeerOk: forced.filter(read => read.status === 200 && read.source === 'peer-fetch').length,
    forcedPeerP50Ms: quantile(forced.filter(read => read.source === 'peer-fetch').map(read => read.ms), 0.5),
    organicP50Ms: quantile(organicOk.map(read => read.ms), 0.5), organicP95Ms: quantile(organicOk.map(read => read.ms), 0.95),
    payloadP95Ms: quantile(payload.map(read => read.ms), 0.95),
    connectedMs: reader.mesh?.connectedMs ?? null, connectedTs: reader.mesh?.connectedTs ?? null, candidateTypes: types,
    peerRttP50Ms: quantile(rtts, 0.5), proofs: peerProofs(reader, swLog), control: reader.control,
  }
}

export function verdict(writer, readers, prereg, swLogs = {}) {
  const per = readers.map(reader => analyzeReader(reader, writer, prereg, swLogs[reader.role]))
  const v = prereg.validity, h = prereg.hypotheses
  const overlap = readers.length === 2 ? (Math.min(...readers.map(r => r.endedTs)) - Math.max(...readers.map(r => r.startedTs))) / 1000 : 0
  const voids = []
  if (readers.length !== 2) voids.push('need exactly two reader files')
  if (writer.acks.length < v.minAckedWrites) voids.push(`only ${writer.acks.length} acknowledged writes (min ${v.minAckedWrites})`)
  if (overlap < v.minOverlapSecs) voids.push(`readers overlapped ${overlap.toFixed(0)} s (min ${v.minOverlapSecs})`)
  for (const r of per) {
    if (!(r.clockUncertaintyMs <= v.maxClockUncertaintyMs)) voids.push(`${r.role}: clock uncertainty ${r.clockUncertaintyMs} ms (max ${v.maxClockUncertaintyMs})`)
    if (r.clockDriftMs !== null && r.clockDriftMs > v.maxClockDriftMs) voids.push(`${r.role}: clock drift ${r.clockDriftMs} ms (max ${v.maxClockDriftMs})`)
    if (r.reads < v.minReadsPerReader) voids.push(`${r.role}: ${r.reads} reads (min ${v.minReadsPerReader})`)
    if ((r.hiddenShare ?? 0) > v.maxHiddenReadShare) voids.push(`${r.role}: ${pct(r.hiddenShare)} of reads with the tab hidden`)
  }
  const sum = pick => per.reduce((total, r) => total + pick(r), 0)
  const types = [...new Set(per.flatMap(r => r.candidateTypes))]
  const peerShare = share(sum(r => r.peerPayloadBytes), sum(r => r.peerPayloadBytes + r.originPayloadBytes))
  const forcedShare = share(sum(r => r.forcedPeerOk), sum(r => r.forcedTrials))
  const measured = per.filter(r => r.proofs.method !== 'not-measured')
  const proofShare = measured.length ? share(sum(r => r.proofs.peer ?? 0), sum(r => (r.proofs.peer ?? 0) + (r.proofs.origin ?? 0))) : null
  const firstProofSecs = measured.map(r => r.proofs.firstPeerTs !== null && r.connectedTs !== null ? Math.max(0, (r.proofs.firstPeerTs - r.connectedTs) / 1000) : null).filter(x => x !== null)
  const connectSecs = per.map(r => r.connectedMs === null ? Infinity : r.connectedMs / 1000)
  const checks = {
    S1: { pass: sum(r => r.violations.length) === 0, value: `${sum(r => r.violations.length)} reads beyond the bound; worst staleness ${Math.max(...per.map(r => r.maxStaleMs))} ms` },
    S2: { pass: sum(r => r.rollbacks.length) === 0, value: `${sum(r => r.rollbacks.length)} rollbacks` },
    S3: { pass: per.every(r => (r.failedShare ?? 1) <= h.S3.maxFailedShare), value: per.map(r => `${r.role} ${pct(r.failedShare)}`).join(', ') + ' failed' },
    F1: { pass: connectSecs.every(s => s <= h.F1.maxConnectSecs), value: `connected in ${connectSecs.map(s => Number.isFinite(s) ? s.toFixed(1) + ' s' : 'never').join(' / ')}; types: ${types.join(', ') || 'none'}`,
      relay: types.includes('relay') },
    F2: { pass: forcedShare !== null && sum(r => r.forcedTrials) >= h.F2.minTrials && forcedShare >= h.F2.minForcedPeerSuccess, value: `${sum(r => r.forcedPeerOk)}/${sum(r => r.forcedTrials)} peer-only reads answered by the peer` },
    F3: { pass: peerShare !== null && peerShare >= h.F3.minPeerPayloadByteShare, value: `${pct(peerShare)} of payload bytes from the peer (ceiling 50 %)` },
    F4: measured.length === 0 ? { pass: null, value: 'not measured (no X-Nodex-Renewal header and no Service Worker log)' }
      : { pass: proofShare !== null && proofShare >= h.F4.minPeerProofShare && firstProofSecs.length > 0 && Math.min(...firstProofSecs) <= h.F4.maxFirstPeerProofSecs,
        value: `${pct(proofShare)} of renewals from the peer (${measured.map(r => r.role + ':' + r.proofs.method).join(', ')}); first peer proof ${firstProofSecs.length ? Math.min(...firstProofSecs).toFixed(1) + ' s after connect' : 'never'}` },
    F5: { pass: per.every(r => r.organicP95Ms !== null && r.organicP95Ms <= h.F5.maxOrganicP95Ms && (r.payloadP95Ms === null || r.payloadP95Ms <= h.F5.maxPayloadReadP95Ms)),
      value: per.map(r => `${r.role} p95 ${r.organicP95Ms} ms, payload p95 ${r.payloadP95Ms} ms`).join('; ') },
  }
  const safety = checks.S1.pass && checks.S2.pass ? 'PASS' : 'FAIL'
  const feas = ['F1', 'F2', 'F3', 'F4', 'F5'].map(id => checks[id].pass)
  const feasibility = feas.includes(false) ? 'FAIL' : feas.includes(null) ? 'INCOMPLETE' : checks.F1.relay ? 'PASS-RELAY' : 'PASS'
  return { prereg: prereg.id, overlapSecs: Math.round(overlap), ackedWrites: writer.acks.length, failedWrites: writer.failedWrites,
    void: voids, safety, availability: checks.S3.pass ? 'PASS' : 'FAIL', feasibility, checks, readers: per }
}

function main() {
  const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : null }
  const need = name => { const value = arg(name); if (!value) { console.error('usage: node analyze.mjs --writer <jsonl> --a <json> --b <json> [--sw-a <jsonl>] [--sw-b <jsonl>] [--json <out>]'); process.exit(2) } return value }
  const prereg = JSON.parse(readFileSync(arg('prereg') ?? join(here, 'prereg-friend.json'), 'utf8'))
  const writer = loadWriter(readFileSync(need('writer'), 'utf8'))
  const readers = [need('a'), need('b')].map(path => JSON.parse(readFileSync(path, 'utf8')))
  const sw = {}
  for (const role of ['a', 'b']) if (arg('sw-' + role)) sw[role.toUpperCase()] = readFileSync(arg('sw-' + role), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const result = verdict(writer, readers, prereg, sw)
  console.log(`\n${result.prereg}: ${result.ackedWrites} acknowledged writes, readers overlapped ${result.overlapSecs} s`)
  for (const r of result.readers) {
    console.log(`  ${r.role} ${r.agent?.browser ?? ''} on ${r.agent?.platform ?? ''}: ${r.reads} reads; cache ${r.sources['sw-cache']}, peer ${r.sources['peer-fetch']}, origin ${r.sources['server-fallback']}; ` +
      `clock +-${r.clockUncertaintyMs} ms; peer RTT p50 ${r.peerRttP50Ms ?? 'n/a'} ms; forced-peer p50 ${r.forcedPeerP50Ms ?? 'n/a'} ms`)
  }
  for (const [id, check] of Object.entries(result.checks)) console.log(`  ${check.pass === null ? 'N/M ' : check.pass ? 'PASS' : 'FAIL'} ${id}  ${check.value}${id === 'F1' && check.relay ? '  [relayed]' : ''}`)
  for (const r of result.readers) for (const x of r.violations.slice(0, 5)) console.log(`    stale: ${r.role} read ${x.i} served v${x.seq} from ${x.source}, ${x.staleMs} ms after v${x.supersededBy} was acknowledged`)
  for (const r of result.readers) for (const x of r.rollbacks.slice(0, 5)) console.log(`    rollback: ${r.role} read ${x.i} served v${x.seq} from ${x.source} after v${x.after}`)
  if (result.void.length) console.log('  VOID: ' + result.void.join('; '))
  console.log(`\n  SAFETY ${result.safety}   AVAILABILITY ${result.availability}   FEASIBILITY ${result.feasibility}${result.void.length ? '   (run is VOID: repeat it)' : ''}\n`)
  if (arg('json')) writeFileSync(arg('json'), JSON.stringify(result, null, 2))
  process.exit(result.safety === 'FAIL' ? 1 : result.void.length ? 2 : result.feasibility === 'FAIL' || result.availability === 'FAIL' ? 1 : 0)
}
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()) main()
