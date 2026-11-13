// Mock origin for rehearsing the friend-test HARNESS (page, probe, writer, analyzer) on one machine.
// It imitates the response contract the page sees (X-Nodex-Source, X-Nodex-Seq, /api/time, /api/write)
// and the runtime globals the probe reads. It is NOT the protocol: no Service Worker, no WebRTC, no
// signatures. It proves the measurement tooling, including that the analyzer catches injected faults.
//
//   node mock-server.mjs [--port 4990] [--fault stale|rollback]
//   open http://127.0.0.1:4990/friend.html?room=demo&role=A&secs=40&sw=skip
//   NODEX_ADMIN_TOKEN=mock node writer.mjs --api http://127.0.0.1:4990 --key friend-demo --period 4000 --bytes 4000 --seconds 60
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const option = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback }
const port = Number(option('port', 4990)), fault = option('fault', '')
const SKEW = 1234 // publisher clock differs from this machine's, so offset handling is exercised
const now = () => Date.now() + SKEW
const versions = new Map() // key -> { seq, bodies: Map<seq, string>, supersededAt: Map<seq, ms> }
const clients = new Map() // key|role -> { held, proofAt, reads, flip }

const runtimeStub = `<!doctype html><meta charset="utf-8"><title>mock runtime</title><script>
setTimeout(() => { window.__peerManagerReady = true }, 300)
window.__peerConnections = new Map()
setTimeout(() => window.__peerConnections.set('mockpeer0001', { state: 'connected' }), 1600)
window.__nodexPeerTelemetry = async () => window.__peerConnections.size ? [{ peer_id: 'mockpeer0001', selected_candidate_type: 'srflx',
  local_candidate_type: 'host', remote_candidate_type: 'srflx', connection_state: 'connected', ice_connection_state: 'connected',
  data_channel_state: 'open', current_round_trip_time_ms: 38.4, dc_open_latency_ms: 412, ice_gather_duration_ms: 120, bytes_sent: 1000, bytes_received: 2000 }] : []
window.__nodexRuntimeConfig = () => ({ iceServerCount: 1, iceTransportPolicy: 'all', signalingUrl: 'not-exported' })
window.__nodexControlMeter = () => ({ scope: 'application-body', discarded: 0, observations: [{ requestBytes: 120, responseBytes: 340 }] })
</script>`

const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Cache-Control': 'no-store', ...headers }); res.end(body) }
const json = (res, status, value, headers) => send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json', ...headers })

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname
  if (req.method === 'GET' && (path === '/friend.html' || path === '/probe.js')) {
    return send(res, 200, readFileSync(join(here, path.slice(1))), { 'Content-Type': path.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' })
  }
  if (path === '/metrics.html') return send(res, 200, runtimeStub, { 'Content-Type': 'text/html; charset=utf-8' })
  if (path === '/api/time') return json(res, 200, { format: 1, nonce: url.searchParams.get('nonce'), serverMs: now() })
  if (req.method === 'POST' && path.startsWith('/api/write/api/products/')) {
    if (req.headers.authorization !== 'Bearer mock') return json(res, 401, { error: 'unauthorized' })
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw), key = path.slice('/api/write'.length)
    const entry = versions.get(key) ?? { seq: 0, bodies: new Map(), supersededAt: new Map() }
    if (body.baseVersion !== entry.seq) return json(res, 409, { error: 'conflict', currentVersion: entry.seq })
    entry.supersededAt.set(entry.seq, now())
    entry.seq++
    entry.bodies.set(entry.seq, JSON.stringify(body.data))
    for (const old of entry.bodies.keys()) if (old < entry.seq - 8) entry.bodies.delete(old)
    versions.set(key, entry)
    return json(res, 200, { version: entry.seq, path: key })
  }
  if (req.method === 'GET' && path.startsWith('/api/products/')) {
    const entry = versions.get(path)
    if (!entry || entry.seq === 0) return send(res, 503, 'no snapshot yet', { 'Retry-After': '1' })
    const role = new URL(req.headers.referer ?? 'http://x/?role=x').searchParams.get('role') ?? 'x'
    const client = clients.get(path + '|' + role) ?? { held: 0, proofAt: 0, reads: 0, flip: 0 }
    clients.set(path + '|' + role, client)
    client.reads++
    const t = now(), forced = req.headers['x-nodex-read-mode'] === 'peer'
    let source, seq = entry.seq, renewal, delay = 2
    const fresh = () => { client.held = entry.seq; client.proofAt = t; client.flip++; return client.flip % 2 ? 'server-fallback' : 'peer-fetch' }
    if (forced) { source = client.reads % 7 === 0 ? 'server-fallback' : 'peer-fetch'; client.held = entry.seq; client.proofAt = t }
    else if (client.held === entry.seq && t - client.proofAt < 5000) source = 'sw-cache'
    else if (client.held === entry.seq) { source = 'sw-cache'; client.proofAt = t; client.flip++; renewal = client.flip % 2 ? 'origin' : 'peer' }
    else if (client.held && t - client.proofAt < 5000) { source = 'sw-cache'; seq = client.held } // old version, still inside its signed window
    else if (fault === 'stale' && client.held && t - (entry.supersededAt.get(client.held) ?? t) < 9000) { source = 'sw-cache'; seq = client.held } // FAULT: window ignored
    else source = fresh()
    if (fault === 'rollback' && client.reads === 12 && seq > 1 && entry.bodies.has(seq - 1)) seq = seq - 1 // FAULT: one older version
    if (source === 'peer-fetch') delay = 55 + Math.random() * 30
    if (source === 'server-fallback') delay = 80 + Math.random() * 40
    await new Promise(resolve => setTimeout(resolve, delay))
    return send(res, 200, entry.bodies.get(seq) ?? '{}', { 'Content-Type': 'application/json', 'X-Nodex-Source': source, 'X-Nodex-Seq': String(seq),
      'X-Nodex-Request-Id': crypto.randomUUID(), ...(renewal ? { 'X-Nodex-Renewal': renewal } : {}) })
  }
  send(res, 404, 'not found')
}).listen(port, '127.0.0.1', () => console.log(`mock origin on http://127.0.0.1:${port}${fault ? ' with fault=' + fault : ''}`))
