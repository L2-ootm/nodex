// Proves the analyzer has teeth and the harness runs end to end.
//
//   node selftest.mjs          synthetic fixtures only (under a second)
//   node selftest.mjs --e2e    also: mock origin + writer + two headless Chromium pages running friend.html,
//                              three times (clean, injected stale reads, injected rollback). About 45 s.
//                              Run from the repository root so @playwright/test resolves.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadWriter, verdict } from './analyze.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const prereg = JSON.parse(readFileSync(join(here, 'prereg-friend.json'), 'utf8'))

// ---- synthetic fixtures -------------------------------------------------------------------------
const T0 = 1_800_000_000_000
function fixture(mutate = () => {}) {
  const acks = Array.from({ length: 20 }, (_, i) => ({ version: i + 1, sendTs: T0 + i * 20000 - 80, ackTs: T0 + i * 20000 }))
  const writer = { acks, uncertaintyMs: 30, failedWrites: 0 }
  const reader = role => {
    const reads = []
    let held = 0, proofAt = 0
    for (let i = 0; i < 360; i++) {
      const ts = T0 + 5000 + i * 1000 + (role === 'B' ? 400 : 0)
      const current = acks.filter(ack => ack.ackTs <= ts).length
      const forced = i >= 300 && i % 5 === 0
      let source = 'sw-cache'
      if (forced || held === 0 || (held !== current && ts - proofAt >= 5000)) { source = forced || (current + (role === 'B' ? 1 : 0)) % 2 ? 'peer-fetch' : 'server-fallback'; held = current; proofAt = ts }
      else if (ts - proofAt >= 5000) proofAt = ts
      reads.push({ i, tl: ts - 7, ts, forced, hidden: false, status: 200, source, seq: held, bytes: 48000, ms: source === 'sw-cache' ? 3 : 90 })
    }
    return { role, key: '/api/products/friend-x', agent: { browser: 'Fixture 1', platform: 'test' }, reads, startedTs: T0, endedTs: T0 + 366000,
      clock: { start: { ok: true, offsetMs: 0, uncertaintyMs: 40 }, end: { ok: true, offsetMs: 10, uncertaintyMs: 45 } },
      mesh: { connectedMs: 9000, connectedTs: T0 + 9000 }, telemetry: [{ type: 'srflx', state: 'connected', channel: 'open', rttMs: 42 }], control: null }
  }
  const readers = [reader('A'), reader('B')]
  mutate(readers, writer)
  return verdict(writer, readers, prereg)
}
const superseded = (readers, lagMs) => { // make A serve v3 lagMs after v4 was acknowledged
  const read = readers[0].reads.find(r => r.ts >= T0 + 3 * 20000 + lagMs)
  for (const r of readers[0].reads) if (r.i <= read.i && r.seq > 3) r.seq = 3
  read.seq = 3; read.source = 'sw-cache'; read.ts = T0 + 3 * 20000 + lagMs
}

const clean = fixture()
assert.equal(clean.safety, 'PASS'); assert.deepEqual(clean.void, [])
assert.equal(clean.checks.F4.pass, null, 'F4 is not measured without a header or worker log')
assert.equal(clean.feasibility, 'INCOMPLETE')

const stale = fixture(readers => superseded(readers, 7000))
assert.equal(stale.safety, 'FAIL'); assert.equal(stale.checks.S1.pass, false)

const inside = fixture(readers => superseded(readers, 5900)) // inside delta + epsilon: must NOT be flagged
assert.equal(inside.checks.S1.pass, true)

const slack = fixture(readers => superseded(readers, 6080)) // beyond 6 s but inside measured clock uncertainty: not provable, not flagged
assert.equal(slack.checks.S1.pass, true)

const rollback = fixture(readers => { readers[1].reads[200].seq -= 1 })
assert.equal(rollback.safety, 'FAIL'); assert.equal(rollback.checks.S2.pass, false)

const blurry = fixture(readers => { readers[0].clock.start.uncertaintyMs = 400 })
assert.ok(blurry.void.some(reason => /clock uncertainty/.test(reason)), 'a blurry clock voids the run')

const noPeer = fixture(readers => { for (const reader of readers) { reader.mesh = { connectedMs: null, connectedTs: null }; reader.telemetry = []; for (const r of reader.reads) if (r.source === 'peer-fetch') r.source = 'server-fallback' } })
assert.equal(noPeer.safety, 'PASS'); assert.equal(noPeer.feasibility, 'FAIL'); assert.equal(noPeer.checks.F1.pass, false)

const relayed = fixture(readers => { for (const reader of readers) { reader.telemetry[0].type = 'relay'; for (const r of reader.reads) if (!r.forced && r.source === 'sw-cache' && r.i % 6 === 0) r.renewal = r.i % 12 ? 'origin' : 'peer' } })
assert.equal(relayed.checks.F4.pass, true); assert.equal(relayed.feasibility, 'PASS-RELAY')
console.log('fixtures: 8/8 ok (clean, stale caught, inside bound not flagged, inside clock slack not flagged, rollback caught, blurry clock voids, no peer fails F1, relay labelled)')

// ---- end to end against the mock -----------------------------------------------------------------
if (process.argv.includes('--e2e')) {
  const { chromium } = await import('@playwright/test')
  const out = join(here, 'out'); mkdirSync(out, { recursive: true })
  const relaxed = structuredClone(prereg)
  Object.assign(relaxed.validity, { minAckedWrites: 5, minReadsPerReader: 15, minOverlapSecs: 15 })
  const browser = await chromium.launch()
  async function scenario(name, port, fault) {
    const children = []
    const start = (file, args, env = {}) => { const child = spawn(process.execPath, [join(here, file), ...args], { env: { ...process.env, ...env }, stdio: 'ignore' }); children.push(child); return child }
    start('mock-server.mjs', ['--port', String(port), ...(fault ? ['--fault', fault] : [])])
    await new Promise(resolve => setTimeout(resolve, 700))
    const writerLog = join(out, `writer-${name}.jsonl`)
    start('writer.mjs', ['--api', `http://127.0.0.1:${port}`, '--key', 'friend-' + name, '--period', '3000', '--bytes', '3000', '--seconds', '34', '--out', writerLog], { NODEX_ADMIN_TOKEN: 'mock' })
    await new Promise(resolve => setTimeout(resolve, 2500))
    try {
      const results = await Promise.all(['A', 'B'].map(async role => {
        const page = await (await browser.newContext({ viewport: { width: 820, height: 1000 } })).newPage()
        await page.goto(`http://127.0.0.1:${port}/friend.html?room=${name}&role=${role}&secs=26&sw=skip&auto=1`)
        if (role === 'A' && !fault) { await page.waitForTimeout(14000); await page.screenshot({ path: join(out, 'friend-running.png') }) }
        await page.waitForFunction(() => Boolean(window.__steerResult), null, { timeout: 60000 })
        if (role === 'A' && !fault) await page.screenshot({ path: join(out, 'friend-done.png'), fullPage: true })
        const result = await page.evaluate(() => window.__steerResult)
        writeFileSync(join(out, `steer-${name}-${role}.json`), JSON.stringify(result))
        return result
      }))
      await new Promise(resolve => setTimeout(resolve, 600))
      return verdict(loadWriter(readFileSync(writerLog, 'utf8')), results, relaxed)
    } finally { for (const child of children) child.kill() }
  }
  const [ok, staleRun, rollbackRun] = await Promise.all([scenario('clean', 4991), scenario('stale', 4992, 'stale'), scenario('rollback', 4993, 'rollback')])
  await browser.close()
  const line = (name, v) => console.log(`e2e ${name}: safety ${v.safety}, feasibility ${v.feasibility}, S1 "${v.checks.S1.value}", S2 "${v.checks.S2.value}", F4 "${v.checks.F4.value}"${v.void.length ? ', void: ' + v.void.join('; ') : ''}`)
  line('clean', ok); line('stale', staleRun); line('rollback', rollbackRun)
  assert.equal(ok.safety, 'PASS'); assert.deepEqual(ok.void, [])
  assert.ok(Math.abs(ok.readers[0].maxStaleMs) <= 6000, 'the clean mock stays inside the bound')
  assert.equal(staleRun.checks.S1.pass, false, 'injected stale reads are caught end to end')
  assert.equal(rollbackRun.checks.S2.pass, false, 'injected rollback is caught end to end')
  console.log('e2e: 3/3 ok. Result files and screenshots in ' + out)
}
