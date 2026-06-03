import type { Browser, BrowserContext, Page } from '@playwright/test'

export interface NodeHandle {
  ctx: BrowserContext
  page: Page
  nodeId: string
  roomId: string
}

export interface NetworkOptions {
  roomId?: string
  topologyLabel?: string
  appOrigin?: string
  signalingUrl?: string
  iceServersJson?: string
  forceRelay?: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildNodeUrl(roomId: string, options: NetworkOptions = {}): string {
  const base = options.appOrigin ?? 'http://localhost:4173/metrics.html'
  const url = new URL(base)
  url.searchParams.set('nodexRoom', roomId)
  url.searchParams.set('nodexTopology', options.topologyLabel ?? 'loopback')
  if (options.signalingUrl) url.searchParams.set('nodexSignalingUrl', options.signalingUrl)
  if (options.iceServersJson) url.searchParams.set('nodexIceServers', options.iceServersJson)
  if (options.forceRelay !== undefined) url.searchParams.set('nodexForceRelay', String(options.forceRelay))
  return url.toString()
}

export async function openNodePage(
  ctx: BrowserContext,
  roomId: string,
  options: NetworkOptions = {}
): Promise<Page> {
  const page = await ctx.newPage()
  const url = buildNodeUrl(roomId, options)
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      lastError = undefined
      break
    } catch (err) {
      lastError = err
      await sleep(500)
    }
  }
  if (lastError) throw lastError
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15000 })
  return page
}

export async function waitForPeerManager(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as unknown as Record<string, unknown>)['__peerManagerReady'],
    { timeout: 10000 }
  )
}

async function installGossipCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as Window & {
      __gossipEvents?: unknown[]
      __gossipChannel?: BroadcastChannel
      __gossipChannelAttached?: boolean
    }

    w.__gossipEvents = []
    if (w.__gossipChannelAttached) {
      return
    }

    const channel = new BroadcastChannel('nodex-metrics')
    channel.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as Record<string, unknown>
      if (data?.['type'] === 'gossip-propagation') {
        w.__gossipEvents?.push({ ...data, t_local: Date.now() })
      }
    })

    w.__gossipChannel = channel
    w.__gossipChannelAttached = true
  })
}

export async function createNetwork(
  browser: Browser,
  size = 10,
  options: NetworkOptions = {}
): Promise<NodeHandle[]> {
  const roomId = options.roomId ?? `room-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const contexts = await Promise.all(
    Array.from({ length: size }, () => browser.newContext())
  )

  try {
    const pages = await Promise.all(contexts.map((ctx) => openNodePage(ctx, roomId, options)))
    await Promise.all(pages.map((page) => waitForPeerManager(page)))
    await Promise.all(pages.map((page) => installGossipCapture(page)))

    const nodeIds = await Promise.all(
      pages.map((page, index) =>
        page.evaluate((fallback: string) => {
          const id = (window as unknown as Record<string, unknown>)['__nodeId']
          return typeof id === 'string' && id.length > 0 ? id : fallback
        }, `node-${index}`)
      )
    )

    return contexts.map((ctx, index) => ({
      ctx,
      page: pages[index],
      nodeId: nodeIds[index],
      roomId,
    }))
  } catch (err) {
    await Promise.all(contexts.map((ctx) => ctx.close().catch(() => undefined)))
    throw err
  }
}

export async function joinNetworkNode(
  browser: Browser,
  roomId: string,
  options: NetworkOptions = {}
): Promise<NodeHandle> {
  const ctx = await browser.newContext()
  try {
    const page = await openNodePage(ctx, roomId, options)
    await waitForPeerManager(page)
    await installGossipCapture(page)
    const nodeId = await page.evaluate(() => {
      const id = (window as unknown as Record<string, unknown>)['__nodeId']
      return typeof id === 'string' && id.length > 0 ? id : `node-${Date.now()}`
    })
    return { ctx, page, nodeId, roomId }
  } catch (err) {
    await ctx.close().catch(() => undefined)
    throw err
  }
}

export async function waitForMesh(
  handles: NodeHandle[],
  minConnsPerNode = 1,
  timeout = 30000
): Promise<void> {
  const deadline = Date.now() + timeout
  let lastCounts: number[] = []

  while (Date.now() < deadline) {
    lastCounts = await Promise.all(
      handles.map((handle) =>
        handle.page.evaluate(() => {
          const conns = (window as unknown as Record<string, unknown>)[
            '__peerConnections'
          ] as Map<string, { state: string }> | undefined

          if (!conns) return 0
          return [...conns.values()].filter((conn) => conn.state === 'connected').length
        })
      )
    )

    if (lastCounts.every((count) => count >= minConnsPerNode)) {
      return
    }

    await sleep(500)
  }

  throw new Error(
    `waitForMesh timed out: not all nodes reached ${minConnsPerNode} connections; counts=${lastCounts.join(',')}`
  )
}

export async function teardownNetwork(handles: NodeHandle[]): Promise<void> {
  await Promise.all(handles.map((handle) => handle.ctx.close().catch(() => undefined)))
}
