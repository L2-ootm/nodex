// Owner side of the friend test: opens friend.html in a real, visible Chromium on the owner's own
// network and records every request the Service Worker itself makes. That log is the only way, without
// changing production code, to tell a renewal proof that came from the peer from one fetched from origin.
// Same technique as tests/beta-real.spec.ts:46 (request.serviceWorker()).
//
//   node research/friend-test/owner-observe.mjs "https://APP/friend.html?room=r1&role=B&api=https://API#nodexBetaToken=..." [--out DIR] [--channel chrome]
//
// Run from the repository root so @playwright/test (already a devDependency, 1.60.0) resolves. Press Start
// in the window at the same moment as the friend. Files written: steer-<room>-<role>.json, sw-<room>-<role>.jsonl.
// Only pathnames are logged: no query strings, no hash, so the invitation token never reaches disk.
import { chromium } from '@playwright/test'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const target = process.argv[2]
const option = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback }
if (!target || !/^https?:/.test(target)) { console.error('usage: node owner-observe.mjs "<friend.html url with #nodexBetaToken=...>" [--out dir] [--channel chrome]'); process.exit(2) }
const url = new URL(target)
const room = url.searchParams.get('room') ?? 'room', role = url.searchParams.get('role') === 'B' ? 'B' : 'A'
const secs = Number(url.searchParams.get('secs')) || 360
const out = resolve(option('out', '.'))
mkdirSync(out, { recursive: true })
const swFile = join(out, `sw-${room}-${role}.jsonl`)
writeFileSync(swFile, '')

const browser = await chromium.launch({ headless: false, channel: option('channel', undefined) })
const context = await browser.newContext()
let workerRequests = 0
context.on('request', request => {
  if (!request.serviceWorker()) return
  workerRequests++
  appendFileSync(swFile, JSON.stringify({ t: Date.now(), path: new URL(request.url()).pathname, method: request.method() }) + '\n')
})
const page = await context.newPage()
await page.goto(url.toString())
console.log('Window open. Press Start together with the other person. Waiting for the run to finish...')
try {
  await page.waitForFunction(() => Boolean(window.__steerResult), null, { timeout: (secs + 600) * 1000, polling: 1000 })
  const result = await page.evaluate(() => window.__steerResult)
  const file = join(out, `steer-${room}-${role}.json`)
  writeFileSync(file, JSON.stringify(result))
  console.log(`Saved ${file} (${result.reads.length} reads) and ${swFile} (${workerRequests} worker requests).`)
  console.log('Leaving the window open for 3 minutes so the other side can finish its peer-only reads. Ctrl+C to stop earlier.')
  await page.waitForTimeout(180000)
} catch (error) {
  console.error('Run did not finish:', String(error?.message ?? error).split('\n')[0])
  process.exitCode = 1
} finally {
  await browser.close()
}
