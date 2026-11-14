// Rehearsal of the two-person test against the deployed pair, before the friend joins.
//
//   NODEX_ADMIN_TOKEN=... node research/friend-test/rehearse-deployed.mjs \
//     [--app https://nodex-beta.vercel.app] [--api https://nodex-beta-api.vercel.app] [--shots <dir>]
//
// It mints its own temporary tester token (so the friend's single-use token is not consumed) and revokes it at
// the end. Part 1 drives the real sign-in and guide pages in a browser; part 2 walks the same API sequence the
// tester pages use: run, enrollment, rooms, evidence, ledger, revocation. Tokens are never printed.
// Leaves one 'rehearsal' run and one evidence row in the production ledger.
import { chromium } from '@playwright/test'

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback }
const app = arg('app', 'https://nodex-beta.vercel.app').replace(/\/$/, '')
const api = arg('api', 'https://nodex-beta-api.vercel.app').replace(/\/$/, '')
const shots = arg('shots', '')
const admin = process.env.NODEX_ADMIN_TOKEN ?? ''
if (!admin) { console.error('NODEX_ADMIN_TOKEN is not set'); process.exit(2) }

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`) }
const call = async (method, path, token, body, extra = {}) => {
  const response = await fetch(api + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}), Origin: app, ...extra }, body: body ? JSON.stringify(body) : undefined })
  const json = await response.json().catch(() => ({}))
  return { status: response.status, json }
}

// Part 2 setup first, so the browser part can sign in with a real tester token.
const minted = await call('POST', '/api/beta/tokens', admin, { role: 'tester', label: 'rehearsal', maxSessions: 1 })
check('admin can mint a tester token', minted.status === 201 && typeof minted.json.token === 'string')
const tester = minted.json.token
const testerId = minted.json.tokenId

const browser = await chromium.launch()
try {
  // Part 1: pages
  const adminCtx = await browser.newContext()
  const page = await adminCtx.newPage()
  await page.goto(app + '/guide')
  await page.getByRole('button', { name: 'Run checks' }).click()
  await page.getByText('Signed clock').waitFor({ timeout: 20000 })
  const guideText = await page.locator('.check-list').innerText()
  check('guide preflight: server reachable', /Server reachable:\s*Beta API answered/.test(guideText))
  check('guide preflight: signed clock available', /Signed clock:\s*Available/.test(guideText), guideText.includes('Signed clock') ? '' : 'missing')
  if (shots) await page.screenshot({ path: `${shots}/guide.png`, fullPage: true })

  await page.goto(app + '/')
  const field = page.getByLabel('Invitation token')
  check('token field is masked', (await field.getAttribute('type')) === 'password')
  await field.fill('nodex-test-not-a-real-token-0000000000')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByText(/not accepted/i).waitFor({ timeout: 15000 })
  check('wrong token is refused with a clear message', true)

  await field.fill(admin)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForURL(/\/admin/, { timeout: 20000 })
  check('admin token opens the control room', true)
  const stored = await page.evaluate(() => ({ session: !!sessionStorage.length, local: Object.keys(localStorage).length }))
  check('invitation is tab-only by default', stored.session && stored.local === 0, JSON.stringify(stored))
  if (shots) await page.screenshot({ path: `${shots}/admin.png` })

  const testerCtx = await browser.newContext()
  const tpage = await testerCtx.newPage()
  await tpage.goto(app + '/')
  await tpage.getByLabel('Invitation token').fill(tester)
  await tpage.getByRole('button', { name: 'Continue' }).click()
  await tpage.waitForURL(/\/setup/, { timeout: 20000 })
  check('tester token opens setup, not admin', true)
  if (shots) await tpage.screenshot({ path: `${shots}/setup.png` })

  // Part 2: API sequence
  const run = await call('POST', '/api/beta/runs', admin, { scenario: 'two-person rehearsal', dataType: 'json', nodeCount: 2, title: 'rehearsal' })
  check('admin creates a run with a room', run.status === 201 && !!run.json.roomId, run.json.roomId ?? '')
  const rooms = await call('GET', '/api/beta/rooms', tester)
  check('tester sees the room', rooms.status === 200 && (rooms.json.rooms ?? []).some(r => r.roomId === run.json.roomId))
  const session = await call('POST', '/api/beta/sessions', tester, { name: 'Rehearsal', consentToCredit: false }, { 'Idempotency-Key': crypto.randomUUID() })
  check('tester enrolls', session.status === 201 && !!session.json.sessionToken, `status ${session.status}`)
  const second = await call('POST', '/api/beta/sessions', tester, { name: 'Again' }, { 'Idempotency-Key': crypto.randomUUID() })
  check('a single-use tester token cannot enroll twice', second.status === 409, `status ${second.status}`)
  const roomId = session.json.roomId
  const hereAdmin = await call('POST', '/api/beta/presence', admin, { name: 'Owner', mode: 'coordinator', roomId })
  const hereTester = await call('POST', '/api/beta/presence', tester, { name: 'Friend', mode: 'tester', roomId, participantId: session.json.participantId })
  check('presence heartbeats are accepted', hereAdmin.status === 200 && hereTester.status === 200, `${hereAdmin.status}/${hereTester.status}`)
  const online = await call('GET', `/api/beta/presence?roomId=${encodeURIComponent(roomId)}`, tester)
  const names = (online.json.online ?? []).map(p => p.name)
  check('both people show as online in the room', names.includes('Owner') && names.includes('Friend'), names.join(','))
  const evidence = await call('POST', '/api/beta/evidence', session.json.sessionToken,
    { participantId: session.json.participantId, roomId: session.json.roomId, topologyLabel: 'rehearsal', result: 'not_measured', notes: 'rehearsal row' })
  check('evidence is recorded against the session', evidence.status === 201, `status ${evidence.status}`)
  const wrong = await call('POST', '/api/beta/evidence', session.json.sessionToken,
    { participantId: session.json.participantId, roomId: 'some-other-room', topologyLabel: 'x', result: 'pass' })
  check('evidence for another room is rejected', wrong.status === 400, `status ${wrong.status}`)
  const asTester = await call('GET', '/api/beta/ledger', tester)
  check('tester cannot read the ledger', asTester.status === 403, `status ${asTester.status}`)
  const ledger = await call('GET', '/api/beta/ledger', admin)
  check('admin ledger lists the rehearsal evidence', ledger.status === 200 && JSON.stringify(ledger.json).includes('rehearsal row'))

  // Throttle: 11 wrong tokens from this address, then even a correct one is refused (this is a per-IP limit, so it
  // locks this machine out for 10 minutes; run it last and only with --throttle).
  if (process.argv.includes('--throttle')) {
    let last = 0
    for (let i = 0; i < 12; i++) last = (await call('POST', '/api/beta/auth', `wrong-${i}-${'x'.repeat(40)}`)).status
    check('repeated wrong tokens are throttled (429)', last === 429, `last status ${last}`)
  }
} finally {
  if (testerId) {
    const revoked = await call('POST', `/api/beta/tokens/${testerId}/revoke`, admin)
    check('rehearsal token revoked', revoked.status === 200, `status ${revoked.status}`)
    // A throttled address is refused even for valid tokens, so this check is meaningless after --throttle.
    if (!process.argv.includes('--throttle')) {
      const after = await call('POST', '/api/beta/auth', tester)
      check('revoked token no longer signs in', after.status === 401 || after.status === 403, `status ${after.status}`)
    }
  }
  await browser.close()
}
const failed = results.filter(r => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
