// Publisher for the friend test. Writes a new version of one public key on a fixed period and logs,
// in publisher time, when each write was sent and acknowledged. analyze.mjs needs this log: it is the
// ground truth for "which version was current when".
//
//   set NODEX_ADMIN_TOKEN=...            (PowerShell: $env:NODEX_ADMIN_TOKEN="...")
//   node writer.mjs --api https://API.example --key friend-r1 [--period 20000] [--bytes 48000] [--seconds 540] [--out writer-r1.jsonl]
//
// Contract used (api/write/[...path].ts): POST /api/write/api/products/<id>, admin bearer, Idempotency-Key,
// body { baseVersion, data }, 200 { version }, 409 { currentVersion }. Body limit is 70,000 bytes.
// The token is read from the environment only and is never logged.
import { appendFileSync, writeFileSync } from 'node:fs'
import { randomUUID, randomBytes } from 'node:crypto'

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback }
const api = (arg('api', '') || '').replace(/\/$/, '')
const id = arg('key', '')
const period = Number(arg('period', 20000))
const bytes = Math.min(Number(arg('bytes', 48000)), 60000)
const seconds = Number(arg('seconds', 540))
const out = arg('out', `writer-${id}.jsonl`)
const token = process.env.NODEX_ADMIN_TOKEN ?? ''
if (!api || !/^[a-zA-Z0-9_-]+$/.test(id)) { console.error('usage: node writer.mjs --api <origin> --key <id> [--period ms] [--bytes n] [--seconds n] [--out file]'); process.exit(2) }
if (!token) { console.error('NODEX_ADMIN_TOKEN is not set'); process.exit(2) }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const local = () => performance.timeOrigin + performance.now()
const log = entry => appendFileSync(out, JSON.stringify(entry) + '\n')

async function syncClock(samples = 5) {
  let best = null
  for (let i = 0; i < samples; i++) {
    try {
      const sent = local()
      const response = await fetch(`${api}/api/time?nonce=${randomBytes(18).toString('base64url')}`, { cache: 'no-store' })
      const body = await response.json()
      const rtt = local() - sent
      if (response.ok && Number.isSafeInteger(body.serverMs) && (!best || rtt < best.rttMs)) best = { offsetMs: body.serverMs - (sent + rtt / 2), rttMs: rtt }
    } catch { /* a failed sample is not counted */ }
    await sleep(250)
  }
  if (!best) throw new Error('could not reach /api/time; the staleness oracle needs publisher time')
  return { offsetMs: Math.round(best.offsetMs), uncertaintyMs: Math.ceil(best.rttMs / 2), rttMs: Math.round(best.rttMs * 10) / 10 }
}

function snapshot(n, sentTs) { // a price board: realistic shape, sized to --bytes
  const rows = []
  const data = { id, n, sentTs, rows }
  while (JSON.stringify(data).length < bytes) {
    rows.push({ sku: randomBytes(4).toString('hex'), bid: +(Math.random() * 1000).toFixed(2), ask: +(Math.random() * 1000).toFixed(2), qty: Math.floor(Math.random() * 5000), venue: 'X' + (rows.length % 7) })
  }
  return data
}

writeFileSync(out, '')
const clock = await syncClock()
log({ type: 'clock', at: 'start', ...clock, api, key: `/api/products/${id}`, period, bytes })
console.log(`clock offset ${clock.offsetMs} ms, uncertainty ${clock.uncertaintyMs} ms; writing /api/products/${id} every ${period} ms for ${seconds} s -> ${out}`)

let baseVersion = 0, n = 0
const started = local()
while (local() - started < seconds * 1000) {
  const due = started + n * period
  if (due > local()) await sleep(due - local())
  n++
  const idempotency = randomUUID()
  for (let attempt = 0; attempt < 3; attempt++) {
    const sent = local()
    const body = JSON.stringify({ baseVersion, data: snapshot(n, Math.round(sent + clock.offsetMs)) })
    let status = 0, reply = {}
    try {
      const response = await fetch(`${api}/api/write/api/products/${id}`, { method: 'POST', body,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': attempt ? randomUUID() : idempotency },
        signal: AbortSignal.timeout(8000) })
      status = response.status
      reply = await response.json().catch(() => ({}))
    } catch (error) { reply = { error: String(error?.name) } }
    const acked = local()
    if (status === 409 && Number.isSafeInteger(reply.currentVersion)) { baseVersion = reply.currentVersion; continue } // adopt the authority's version and retry
    const ok = status === 200 && Number.isSafeInteger(reply.version)
    log({ type: 'write', n, ok, status, version: ok ? reply.version : null, sendTs: Math.round(sent + clock.offsetMs), ackTs: Math.round(acked + clock.offsetMs),
      ms: Math.round(acked - sent), bodyBytes: body.length, error: ok ? undefined : reply.error })
    if (ok) { baseVersion = reply.version; process.stdout.write(`v${reply.version} `) } else process.stdout.write(`[${status}] `)
    break
  }
}
const end = await syncClock(3).catch(() => null)
log({ type: 'clock', at: 'end', ...(end ?? { failed: true }) })
console.log(`\ndone: ${n} writes attempted. Log: ${out}`)
