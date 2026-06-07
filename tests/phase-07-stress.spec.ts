import { expect, test, type Page } from '@playwright/test'
import {
  createNetwork,
  openNodePage,
  teardownNetwork,
  waitForMesh,
  waitForPeerManager,
  type NodeHandle,
} from './helpers/harness'
import type { PeerTelemetrySample } from './helpers/report-writer'

test.describe.configure({ mode: 'serial' })

async function collectTelemetry(page: Page): Promise<PeerTelemetrySample[]> {
  return page.evaluate(async () => {
    const fn = (window as unknown as Record<string, unknown>)['__nodexPeerTelemetry']
    if (typeof fn !== 'function') return []
    return await (fn as () => Promise<unknown[]>)()
  }) as Promise<PeerTelemetrySample[]>
}

async function leadershipState(page: Page): Promise<{ isLeader: boolean; role: string }> {
  return page.evaluate(() => {
    const fn = (window as unknown as Record<string, unknown>)['__nodexP2PLeadership']
    if (typeof fn !== 'function') return { isLeader: false, role: 'unknown' }
    return (fn as () => { isLeader: boolean; role: string })()
  })
}

async function runtimeConfigSnapshot(page: Page): Promise<{
  forceRelay: boolean
  iceTransportPolicy: string
  iceServerCount: number
}> {
  return page.evaluate(() => {
    const fn = (window as unknown as Record<string, unknown>)['__nodexRuntimeConfig']
    if (typeof fn !== 'function') throw new Error('__nodexRuntimeConfig hook missing')
    return (fn as () => { forceRelay: boolean; iceTransportPolicy: string; iceServerCount: number })()
  })
}

async function peerIds(handle: NodeHandle): Promise<string[]> {
  return handle.page.evaluate(() => {
    const conns = (window as unknown as Record<string, unknown>)['__peerConnections'] as
      | Map<string, unknown>
      | undefined
    return conns ? [...conns.keys()] : []
  })
}

test('EXT-STRESS-01: independent rooms do not leak peer identities across local meshes', async ({ browser }) => {
  test.setTimeout(120_000)
  const alpha = await createNetwork(browser, 2, { topologyLabel: 'stress-room-alpha' })
  const beta = await createNetwork(browser, 2, { topologyLabel: 'stress-room-beta' })

  try {
    await waitForMesh(alpha, 1, 30_000)
    await waitForMesh(beta, 1, 30_000)

    const alphaPeers = new Set((await Promise.all(alpha.map(peerIds))).flat())
    const betaNodeIds = new Set(beta.map((handle) => handle.nodeId))
    const overlap = [...alphaPeers].filter((peerId) => betaNodeIds.has(peerId))

    expect(overlap).toEqual([])
  } finally {
    await teardownNetwork([...alpha, ...beta])
  }
})

test('EXT-STRESS-02: multi-tab leader lease fails over after active tab closes', async ({ browser }) => {
  test.setTimeout(90_000)
  const ctx = await browser.newContext()
  const roomId = `phase7-stress-tabs-${Date.now()}`

  try {
    const first = await openNodePage(ctx, roomId, { topologyLabel: 'stress-tabs' })
    await waitForPeerManager(first)
    const second = await openNodePage(ctx, roomId, { topologyLabel: 'stress-tabs' })
    await waitForPeerManager(second)

    const initial = await Promise.all([first, second].map((page) => leadershipState(page)))
    expect(initial.filter((state) => state.isLeader)).toHaveLength(1)

    const leaderIndex = initial.findIndex((state) => state.isLeader)
    const leader = leaderIndex === 0 ? first : second
    const follower = leaderIndex === 0 ? second : first
    await leader.close()

    await expect
      .poll(async () => leadershipState(follower), { timeout: 8_000, intervals: [500] })
      .toMatchObject({ isLeader: true, role: 'leader' })
  } finally {
    await ctx.close().catch(() => undefined)
  }
})

test('EXT-STRESS-03: repeated local writes keep storage pressure observable and bounded', async ({ browser }) => {
  test.setTimeout(90_000)
  const handles = await createNetwork(browser, 1, { topologyLabel: 'stress-storage' })

  try {
    for (let i = 0; i < 25; i++) {
      const status = await handles[0].page.evaluate((index) =>
        fetch(`/api/products/stress-storage-${Date.now()}-${index}`).then((response) => response.status),
      i)
      expect(status).toBe(200)
    }

    const sample = await handles[0].page.evaluate(async () => {
      const fn = (window as unknown as Record<string, unknown>)['__nodexStoragePressure']
      if (typeof fn !== 'function') throw new Error('__nodexStoragePressure hook missing')
      return await (fn as () => Promise<{ usage_ratio: number | null; quota_bytes: number | null }>)()
    })

    if (sample.usage_ratio !== null) {
      expect(sample.usage_ratio).toBeGreaterThanOrEqual(0)
      expect(sample.usage_ratio).toBeLessThanOrEqual(1)
    }
    expect(sample).toHaveProperty('quota_bytes')
  } finally {
    await teardownNetwork(handles)
  }
})

test('EXT-STRESS-04: force-relay runtime configuration is externally observable without TURN secrets', async ({ browser }) => {
  test.setTimeout(60_000)
  const ctx = await browser.newContext()
  const roomId = `phase7-stress-relay-${Date.now()}`
  const iceServersJson = JSON.stringify([{ urls: ['stun:stun.l.google.com:19302'] }])

  try {
    const page = await openNodePage(ctx, roomId, {
      topologyLabel: 'stress-relay-config',
      iceServersJson,
      forceRelay: true,
    })
    await waitForPeerManager(page)

    await expect.poll(() => runtimeConfigSnapshot(page), { timeout: 5_000 }).toMatchObject({
      forceRelay: true,
      iceTransportPolicy: 'relay',
      iceServerCount: 1,
    })
  } finally {
    await ctx.close().catch(() => undefined)
  }
})

test('EXT-STRESS-05: churned local node rejoins repeatedly and emits connected telemetry', async ({ browser }) => {
  test.setTimeout(180_000)
  const handles = await createNetwork(browser, 3, { topologyLabel: 'stress-churn' })

  try {
    await waitForMesh(handles, 1, 30_000)

    for (let i = 0; i < 3; i++) {
      const churned = handles.pop()
      expect(churned).toBeTruthy()
      await churned!.ctx.close()

      const replacement = await createNetwork(browser, 1, {
        roomId: handles[0].roomId,
        topologyLabel: 'stress-churn',
      })
      handles.push(replacement[0])
      await waitForMesh(handles, 1, 45_000)
    }

    const samples = (await Promise.all(handles.map((handle) => collectTelemetry(handle.page)))).flat()
    expect(samples.some((sample) => sample.connection_state === 'connected')).toBe(true)
  } finally {
    await teardownNetwork(handles)
  }
})
