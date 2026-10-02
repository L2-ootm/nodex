import { expect, test } from '@playwright/test'

// Real loopback APIs, WebCrypto, Service Worker, HTTP signaling and local persistence.
// No routed responses. This establishes local usability, not WAN or billing results.
test('tester enrolls, measures a solo run and persists qualified evidence', async ({ page, request }) => {
  await page.goto('/')
  await page.getByLabel('Invitation token').fill('nodex-tester-local-development')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL(/\/setup$/)
  await page.getByRole('link', { name: 'Start setup' }).click()
  await page.getByLabel('Name').fill('Real protocol tester')
  await page.getByLabel('City').fill('Sao Paulo')
  await page.getByLabel('Country').fill('BR')
  await page.getByLabel('Network').fill('loopback')
  await page.getByLabel('Consent to be credited').check()
  await page.getByRole('button', { name: 'Save profile and continue' }).click()
  await expect(page).toHaveURL(/\/room$/)
  await page.getByRole('button', { name: 'Open solo room' }).click()
  await page.getByRole('button', { name: 'Run guided test' }).click()
  await page.getByRole('button', { name: 'Run real protocol test' }).click()
  await expect(page.getByText('Evidence bundle prepared')).toHaveClass(/done/, { timeout: 25000 })
  const run = await page.evaluate(() => JSON.parse(localStorage.getItem('nodex-next-run-evidence-v1') ?? 'null'))
  expect(run.resultHint).toBe('partial')
  expect(run.reads).toHaveLength(18)
  expect(new Set(run.reads.map((read: { requestId: string }) => read.requestId)).size).toBe(18)
  expect(run.economics.matchedWorkload).toBe(true)
  expect(run.economics.netSavingsUsdPerObservedBrowserHourEstimate).toBeNull()
  expect(run.metrics.peerFetch).toBe(0)
  await page.getByRole('button', { name: 'Continue to evidence' }).click()
  await expect(page.getByLabel('Result')).toHaveValue('partial')
  await page.getByRole('button', { name: 'Send evidence' }).click()
  await expect(page).toHaveURL(/\/receipt$/)
  const ledger = await request.get('http://localhost:33003/api/beta/ledger', {
    headers: { Authorization: 'Bearer nodex-admin-local-development' },
  })
  expect(ledger.ok()).toBe(true)
  expect((await ledger.json()).evidence.some((entry: { result: string }) => entry.result === 'partial')).toBe(true)
})

test('two real browsers discover each other through HTTP signaling and deliver a verified peer read', async ({ browser }) => {
  test.setTimeout(60000)
  const contexts = await Promise.all([browser.newContext(), browser.newContext()])
  try {
    const room = 'real-http-' + crypto.randomUUID()
    const url = new URL('http://localhost:4176/metrics.html')
    url.searchParams.set('nodexRoom', room)
    url.searchParams.set('nodexSignalingUrl', 'http://localhost:33003/api/signal')
    url.searchParams.set('nodexApiOrigin', 'http://localhost:33003')
    url.hash = 'nodexBetaToken=nodex-tester-local-development'
    const pages = await Promise.all(contexts.map(async context => {
      const page = await context.newPage()
      page.on('console', message => {
        if (message.type() === 'warning' || message.type() === 'error') console.log('Protocol console:', message.text().slice(0, 300))
      })
      await page.goto(url.toString()); return page
    }))
    for (const page of pages) page.on('response', response => {
      if (response.status() >= 400 && new URL(response.url()).pathname.startsWith('/api/')) {
        console.log('Protocol HTTP failure:', response.status(), new URL(response.url()).pathname)
      }
    })
    await Promise.all(pages.map(page => page.waitForFunction(() => {
      const runtime = window as unknown as { __peerManagerReady?: boolean; __peerConnections?: Map<string, { state: string }> }
      return runtime.__peerManagerReady && [...(runtime.__peerConnections?.values() ?? [])].some(peer => peer.state === 'connected')
    }, null, { timeout: 25000 }))).catch(async error => {
      for (const page of pages) console.log('Peer readiness:', await page.evaluate(() => {
        const runtime = window as unknown as { __peerManagerReady?: boolean; __peerConnections?: Map<string, { state: string; polite: boolean; pc: RTCPeerConnection }> }
        return { ready: runtime.__peerManagerReady, peers: [...(runtime.__peerConnections?.values() ?? [])].map(peer => ({ state: peer.state,
          polite: peer.polite, signaling: peer.pc.signalingState, ice: peer.pc.iceConnectionState })) }
      }))
      throw error
    })
    const seeded = await pages[0]!.evaluate(async () => {
      const response = await fetch('/api/products/peer-proof', { headers: { 'X-Nodex-Read-Mode': 'cache' } })
      return { status: response.status, body: await response.text(), version: response.headers.get('X-Nodex-Seq') }
    })
    expect(seeded.status).toBe(200)
    const delivered = await pages[1]!.evaluate(async () => {
      const response = await fetch('/api/products/peer-proof', { headers: { 'X-Nodex-Read-Mode': 'peer' } })
      return { status: response.status, source: response.headers.get('X-Nodex-Source'),
        id: response.headers.get('X-Nodex-Request-Id'), version: response.headers.get('X-Nodex-Seq'), body: await response.text() }
    })
    expect(delivered).toMatchObject({ status: 200, source: 'peer-fetch', version: seeded.version, body: seeded.body })
    expect(delivered.id).toBeTruthy()
  } finally { await Promise.all(contexts.map(context => context.close())) }
})

test('worker restart recovers its reader key through the authorized page', async ({ page, context, request }) => {
  expect((await request.get('http://localhost:33003/api/session-key')).status()).toBe(401)
  const url = new URL('http://localhost:4176/metrics.html')
  url.searchParams.set('nodexRoom', 'restart-' + crypto.randomUUID())
  url.searchParams.set('nodexSignalingUrl', 'http://localhost:33003/api/signal')
  url.searchParams.set('nodexApiOrigin', 'http://localhost:33003')
  url.hash = 'nodexBetaToken=nodex-tester-local-development'
  await page.goto(url.toString())
  await page.waitForFunction(() => (window as unknown as { __peerManagerReady?: boolean }).__peerManagerReady)
  const snapshot = () => page.evaluate(async () => {
    const channel = new MessageChannel()
    return new Promise<string>(resolve => {
      channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data.workerInstance) }
      navigator.serviceWorker.controller!.postMessage({ type: 'CONTROL_SNAPSHOT' }, [channel.port2])
    })
  })
  const before = await snapshot()
  const cdp = await context.newCDPSession(page)
  let versions: Array<{ versionId: string; scriptURL: string; status: string }> = []
  cdp.on('ServiceWorker.workerVersionUpdated', event => { versions = event.versions })
  await cdp.send('ServiceWorker.enable')
  await expect.poll(() => versions.find(version => version.scriptURL.endsWith('/sw.js') && version.status === 'activated')?.versionId).toBeTruthy()
  const versionId = versions.find(version => version.scriptURL.endsWith('/sw.js') && version.status === 'activated')!.versionId
  await cdp.send('ServiceWorker.stopWorker', { versionId })
  const delivered = await page.evaluate(async () => {
    const response = await fetch('/api/products/restarted-reader', { cache: 'no-store' })
    return { status: response.status, source: response.headers.get('X-Nodex-Source'),
      consistency: response.headers.get('X-Nodex-Consistency'), body: await response.json() }
  })
  expect(delivered).toMatchObject({ status: 200, source: 'server-fallback',
    consistency: 'public-monotonic-durable', body: { id: 'restarted-reader' } })
  expect(await snapshot()).not.toBe(before)
  await cdp.detach()
})
