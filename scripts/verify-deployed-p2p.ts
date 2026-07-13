import { chromium, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { openNodesForMode, resolveJoinMode } from './verify-deployed-p2p-options.js'

// Load .env.backend as fallback — shell env takes precedence over file values
function loadEnvFile(filePath: string): void {
  try {
    const content = readFileSync(filePath, 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq < 1) continue
      const key = trimmed.slice(0, eq).trim()
      const raw = trimmed.slice(eq + 1).trim()
      const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
      if (key && !(key in process.env)) process.env[key] = value
    }
  } catch {
    // file absent — ok, rely on shell env
  }
}
loadEnvFile(resolve(process.cwd(), '.env.backend'))

const appOrigin = process.env['NODEX_DEPLOYED_APP_ORIGIN'] ?? 'https://nodex-beta.vercel.app/metrics.html'
const signalingUrl = process.env['NODEX_DEPLOYED_SIGNALING_URL'] ?? 'https://nodex-beta-api.vercel.app/api/signal'
const apiOrigin = process.env['NODEX_DEPLOYED_API_ORIGIN'] ?? 'https://nodex-beta-api.vercel.app'
const roomId = process.env['NODEX_DEPLOYED_ROOM_ID'] ?? `deploy-smoke-${Date.now()}`
const joinMode = resolveJoinMode()

function firstTesterTokenFromEnv(): string {
  const raw = process.env['NODEX_BETA_TOKENS'] ?? ''
  return raw.split(/,(?=nodex-)/)[0]?.split('|')[0]?.trim() ?? ''
}

const betaToken = process.env['NODEX_DEPLOYED_BETA_TOKEN'] ?? firstTesterTokenFromEnv()

function tokenFingerprint(token: string): string {
  if (!token) return '(none)'
  return `${token.slice(0, 4)}…[len=${token.length}]`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nodeUrl(): string {
  const url = new URL(appOrigin)
  url.searchParams.set('nodexRoom', roomId)
  url.searchParams.set('nodexTopology', 'deployed-smoke')
  url.searchParams.set('nodexSignalingUrl', signalingUrl)
  url.searchParams.set('nodexApiOrigin', apiOrigin)
  if (betaToken) url.searchParams.set('nodexBetaToken', betaToken)
  return url.toString()
}

function tokenHeaders(): Record<string, string> {
  return betaToken ? { Authorization: `Bearer ${betaToken}` } : {}
}

function safeResponseUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    for (const key of [...url.searchParams.keys()]) {
      if (/token|authorization|secret|key/i.test(key)) {
        url.searchParams.set(key, '[redacted]')
      }
    }
    return url.toString()
  } catch {
    return rawUrl.replace(/(nodexBetaToken|token|authorization|secret|key)=([^&\s]+)/gi, '$1=[redacted]')
  }
}

async function openNode(page: Page, label: string): Promise<void> {
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.text().includes('[p2p]') || msg.text().includes('[P2P]') || msg.text().includes('[signal]') || msg.text().includes('[SW]')) {
      console.log(`[${label} console ${msg.type()}] ${msg.text()}`)
    }
  })
  page.on('response', (response) => {
    const status = response.status()
    if (status >= 400) {
      console.log(`[${label} response ${status}] ${safeResponseUrl(response.url())}`)
    }
  })
  const launchUrl = nodeUrl()
  console.log(`[${label}] launching url (token in params: ${launchUrl.includes('nodexBetaToken') ? 'yes' : 'NO'})`)
  await page.goto(launchUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 20_000 })
  await page.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>)['__peerManagerReady']), { timeout: 20_000 })
  const joinInfo = await page.evaluate(async ([sigUrl, authHeader]: [string, string]) => {
    const nodeId = (window as unknown as Record<string, unknown>)['__nodeId']
    const roomId = new URLSearchParams(location.search).get('nodexRoom') ?? 'unknown'
    const configFn = (window as unknown as Record<string, unknown>)['__nodexRuntimeConfig']
    const config = typeof configFn === 'function' ? (configFn as () => Record<string, unknown>)() : {}
    const configProof = {
      apiOrigin: config['apiOrigin'],
      signalingUrl: config['signalingUrl'],
      hasToken: Boolean(config['apiTokenPresent']),
      tokenLen: typeof config['apiTokenLength'] === 'number' ? config['apiTokenLength'] : 0,
      urlHasToken: new URLSearchParams(location.search).has('nodexBetaToken'),
    }
    const conns = (window as unknown as Record<string, unknown>)['__peerConnections'] as Map<string, { state: string }> | undefined
    const connectionsSize = conns ? conns.size : -1
    const connectionStates = conns ? [...conns.values()].map((c) => c.state) : []
    try {
      const headers: Record<string, string> = authHeader ? { Authorization: authHeader } : {}
      const pollUrl = `${sigUrl}/poll?roomId=${encodeURIComponent(roomId)}&nodeId=${encodeURIComponent(String(nodeId))}&after=0`
      const res = await fetch(pollUrl, { headers })
      if (!res.ok) {
        return { nodeId, roomId, pollStatus: res.status, pollUrl, configProof, connectionsSize, connectionStates, messageCount: 0 }
      }
      const body = await res.json()
      return { nodeId, roomId, pollStatus: res.status, configProof, connectionsSize, connectionStates, messageCount: (body as { messages?: unknown[] })?.messages?.length ?? 0 }
    } catch (err) {
      return { nodeId, roomId, pollStatus: -1, pollError: String(err), configProof, connectionsSize, connectionStates }
    }
  }, [signalingUrl, betaToken ? `Bearer ${betaToken}` : ''] as [string, string])
  console.log(`[${label} join] nodeId=${joinInfo.nodeId} roomId=${joinInfo.roomId} poll=${joinInfo.pollStatus} messages=${joinInfo.messageCount ?? 0} connections=${joinInfo.connectionsSize} states=${JSON.stringify(joinInfo.connectionStates)}`)
  console.log(`[${label} config] apiOrigin=${joinInfo.configProof?.apiOrigin} signalingUrl=${joinInfo.configProof?.signalingUrl} hasToken=${joinInfo.configProof?.hasToken} tokenLen=${joinInfo.configProof?.tokenLen} urlHasToken=${joinInfo.configProof?.urlHasToken}`)
  if (joinInfo.pollStatus === 401 || joinInfo.pollStatus === 502 || joinInfo.pollStatus === 508) {
    console.error(`[${label}] poll returned ${joinInfo.pollStatus}${'pollUrl' in joinInfo ? ` url=${String((joinInfo as Record<string, unknown>)['pollUrl'])}` : ''}`)
  }
  await page.evaluate(() => {
    const w = window as Window & {
      __nodexSmokeMetrics?: unknown[]
      __nodexSmokeChannel?: BroadcastChannel
    }
    w.__nodexSmokeMetrics = []
    w.__nodexSmokeChannel?.close()
    const channel = new BroadcastChannel('nodex-metrics')
    channel.onmessage = (event: MessageEvent) => {
      w.__nodexSmokeMetrics?.push(event.data)
    }
    w.__nodexSmokeChannel = channel
  })
}

async function connectedPeerCount(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const conns = (window as unknown as Record<string, unknown>)['__peerConnections'] as
      | Map<string, { state: string }>
      | undefined
    return conns ? [...conns.values()].filter((conn) => conn.state === 'connected').length : 0
  })
}

async function waitForMesh(a: Page, b: Page): Promise<void> {
  const deadline = Date.now() + 45_000
  let counts = [0, 0]
  while (Date.now() < deadline) {
    counts = [await connectedPeerCount(a), await connectedPeerCount(b)]
    if (counts.every((count) => count >= 1)) return
    await sleep(500)
  }
  throw new Error(`mesh connection timeout; counts=${counts.join(',')}`)
}

async function metricCounts(page: Page): Promise<Record<string, number>> {
  return await page.evaluate(() => {
    const events = ((window as unknown as Record<string, unknown>)['__nodexSmokeMetrics'] as Array<{ type?: string }> | undefined) ?? []
    return events.reduce<Record<string, number>>((acc, event) => {
      if (event.type) acc[event.type] = (acc[event.type] ?? 0) + 1
      return acc
    }, {})
  })
}

async function runtimeConfig(page: Page): Promise<unknown> {
  return await page.evaluate(() => {
    const fn = (window as unknown as Record<string, unknown>)['__nodexRuntimeConfig']
    return typeof fn === 'function' ? (fn as () => unknown)() : null
  })
}

async function authPreflight(): Promise<void> {
  console.log(`[preflight] token fingerprint: ${tokenFingerprint(betaToken)}`)
  console.log(`[preflight] apiOrigin: ${apiOrigin}`)
  console.log(`[preflight] signalingUrl: ${signalingUrl}`)
  const res = await fetch(`${apiOrigin}/api/session-key`, {
    headers: betaToken ? { Authorization: `Bearer ${betaToken}` } : {},
  })
  if (!res.ok) {
    throw new Error(`[preflight] /api/session-key returned ${res.status} — token is invalid or missing. Aborting before launching browsers.`)
  }
  console.log(`[preflight] /api/session-key → ${res.status} ok`)
}

async function main(): Promise<void> {
  console.log(`[preflight] joinMode: ${joinMode}`)
  await authPreflight()

  const browser = await chromium.launch()
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()

  try {
    await openNodesForMode(
      joinMode,
      () => openNode(pageA, 'nodeA'),
      () => openNode(pageB, 'nodeB'),
      () => sleep(2000),
    )
    try {
      await waitForMesh(pageA, pageB)
    } catch (err) {
      throw new Error(`mesh connection timeout in ${joinMode} mode for room ${roomId}: ${err instanceof Error ? err.message : String(err)}`)
    }

    const seed = await pageA.evaluate(async () => {
      const res = await fetch('/api/products/1', { cache: 'no-store' })
      return { ok: res.ok, status: res.status, seq: res.headers.get('X-Nodex-Seq') }
    })
    if (!seed.ok) throw new Error(`seed fetch failed with HTTP ${seed.status}`)

    await pageB.evaluate(() => {
      ;(window as unknown as Record<string, unknown>)['__nodexSmokeMetrics'] = []
    })

    const peerRead = await pageB.evaluate(async () => {
      const res = await fetch('/api/products/1')
      const body = await res.text()
      return {
        ok: res.ok,
        status: res.status,
        seq: res.headers.get('X-Nodex-Seq'),
        bodyPreview: body.slice(0, 80),
      }
    })
    if (!peerRead.ok) throw new Error(`peer read fetch failed with HTTP ${peerRead.status}`)

    const deadline = Date.now() + 8_000
    let counts = await metricCounts(pageB)
    while (Date.now() < deadline && !counts['peer-fetch']) {
      await sleep(250)
      counts = await metricCounts(pageB)
    }

    const result = {
      joinMode,
      roomId,
      appOrigin,
      signalingUrl,
      connectedPeers: {
        nodeA: await connectedPeerCount(pageA),
        nodeB: await connectedPeerCount(pageB),
      },
      seed,
      peerRead,
      nodeBMetrics: counts,
      runtimeConfig: await runtimeConfig(pageB),
    }

    console.log(JSON.stringify(result, null, 2))
    if (!counts['peer-fetch']) {
      throw new Error(`connected mesh formed, but peer-fetch metric was not observed; metrics=${JSON.stringify(counts)}`)
    }
  } finally {
    await Promise.all([
      contextA.close().catch(() => undefined),
      contextB.close().catch(() => undefined),
    ])
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
