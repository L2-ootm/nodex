import { expect, test, type Page } from '@playwright/test'
import * as fs from 'fs/promises'
import { createNetwork, teardownNetwork, waitForMesh, type NodeHandle } from './helpers/harness'
import { writeAcademicExport, type Phase05Report } from './helpers/report-writer'

test.describe.configure({ mode: 'serial' })

interface RuntimeFlags {
  disableP2P?: boolean
  disableCacheRead?: boolean
}

interface CacheState {
  key: string
  hasCache: boolean
  latestSeq: number
  cachedSeq: number
}

interface RevalidateResult {
  key: string
  localSeqBefore: number
  serverSeq: number
  repaired: boolean
  deletedCache: boolean
}

interface LatencyCounts {
  sw_cache: number
  peer_fetch: number
  server_fallback: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeExportFixture(): Phase05Report {
  return {
    timestamp: new Date().toISOString(),
    convergence: {
      runs: 30,
      p50_ms: 7,
      p95_ms: 9,
      max_ms: 10,
      all_nodes_received_pct: 0.83,
      avg_hop_count: 12.37,
      dedup_verified: true,
    },
    cache_hit_rate: {
      total_requests: 101,
      sw_cache: 46,
      peer_fetch: 50,
      server_fallback: 5,
      p2p_hit_rate_pct: 95.05,
    },
    latency_percentiles: {
      sw_cache: { p50: 1.1, p95: 1.4, p99: 1.5, count: 46 },
      peer_fetch: { p50: 2.5, p95: 3.4, p99: 5.7, count: 50 },
      server_fallback: { p50: 7.5, p95: 8.9, p99: 8.9, count: 5 },
    },
  }
}

async function readPhase5ReportOrFixture(): Promise<Phase05Report> {
  try {
    const raw = await fs.readFile('test-results/phase-05-metrics.json', 'utf8')
    return JSON.parse(raw) as Phase05Report
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
    return makeExportFixture()
  }
}

async function sendSwMessage<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((payload) => {
    return new Promise((resolve, reject) => {
      const controller = navigator.serviceWorker.controller
      if (!controller) {
        reject(new Error('service worker controller unavailable'))
        return
      }

      const channel = new MessageChannel()
      const timeout = setTimeout(() => reject(new Error(`SW message timeout: ${payload.type}`)), 5000)
      channel.port1.onmessage = (event) => {
        clearTimeout(timeout)
        resolve(event.data)
      }
      controller.postMessage(payload, [channel.port2])
    })
  }, message) as Promise<T>
}

async function setRuntimeFlags(handle: NodeHandle, flags: RuntimeFlags): Promise<RuntimeFlags> {
  const response = await sendSwMessage<{ flags: RuntimeFlags }>(handle.page, {
    type: 'SET_RUNTIME_FLAGS',
    flags,
  })
  return response.flags
}

async function getCacheState(handle: NodeHandle, key: string): Promise<CacheState> {
  return sendSwMessage<CacheState>(handle.page, { type: 'GET_CACHE_STATE', key })
}

async function revalidateKey(handle: NodeHandle, key: string): Promise<RevalidateResult> {
  return sendSwMessage<RevalidateResult>(handle.page, { type: 'REVALIDATE_KEY', key })
}

async function fetchKey(handle: NodeHandle, key: string): Promise<number> {
  return handle.page.evaluate((cacheKey) => fetch(cacheKey).then((response) => response.status), key)
}

async function postRoomGossip(handles: NodeHandle[], key: string, seq: number): Promise<string[]> {
  const response = await handles[0].page.request.post('http://localhost:3001/api/gossip-seed', {
    data: { path: key, seq, room: handles[0].roomId },
    headers: { 'Content-Type': 'application/json' },
  })
  expect(response.ok()).toBe(true)
  const body = await response.json() as { seededNodeIds: string[] }
  return body.seededNodeIds
}

async function matchingGossipCount(handle: NodeHandle, key: string): Promise<number> {
  return handle.page.evaluate((eventKey) => {
    const events = (window as unknown as Record<string, unknown>)['__gossipEvents'] as
      | Record<string, unknown>[]
      | undefined
    return (events ?? []).filter((event) => event['key'] === eventKey).length
  }, key)
}

async function connectedPeerIds(handle: NodeHandle): Promise<string[]> {
  return handle.page.evaluate(() => {
    const conns = (window as unknown as Record<string, unknown>)['__peerConnections'] as
      | Map<string, { state: string }>
      | undefined
    if (!conns) return []
    return [...conns.entries()]
      .filter(([, conn]) => conn.state === 'connected')
      .map(([peerId]) => peerId)
  })
}

async function aggregateLatencyCounts(handles: NodeHandle[]): Promise<LatencyCounts> {
  const perNode = await Promise.all(
    handles.map((handle) =>
      handle.page.evaluate(() => {
        const acc = (window as unknown as Record<string, unknown>)['__latencyAccumulator'] as
          | { getStats: (type: string) => { count: number } }
          | undefined
        const count = (type: string) => acc?.getStats(type).count ?? 0
        return {
          sw_cache: count('sw-cache'),
          peer_fetch: count('peer-fetch'),
          server_fallback: count('server-fallback'),
        }
      })
    )
  )

  return perNode.reduce<LatencyCounts>(
    (sum, counts) => ({
      sw_cache: sum.sw_cache + counts.sw_cache,
      peer_fetch: sum.peer_fetch + counts.peer_fetch,
      server_fallback: sum.server_fallback + counts.server_fallback,
    }),
    { sw_cache: 0, peer_fetch: 0, server_fallback: 0 }
  )
}

async function runPeerWorkload(handles: NodeHandle[], key: string, requestCount: number): Promise<LatencyCounts> {
  expect(await fetchKey(handles[0], key)).toBe(200)
  await handles[0].page.waitForTimeout(300)

  for (let i = 0; i < requestCount; i++) {
    expect(await fetchKey(handles[i % handles.length], key)).toBe(200)
    await handles[0].page.waitForTimeout(20)
  }

  await handles[0].page.waitForTimeout(800)
  return aggregateLatencyCounts(handles)
}

test('DEMO-01a: room-scoped signaling isolates simultaneous demo networks', async ({ browser }) => {
  test.setTimeout(120_000)
  const roomA = `phase6-a-${Date.now()}`
  const roomB = `phase6-b-${Date.now()}`
  const handlesA = await createNetwork(browser, 3, { roomId: roomA })
  const handlesB = await createNetwork(browser, 3, { roomId: roomB })

  try {
    await Promise.all([
      waitForMesh(handlesA, 1, 30_000),
      waitForMesh(handlesB, 1, 30_000),
    ])

    const nodeIdsA = new Set(handlesA.map((handle) => handle.nodeId))
    const nodeIdsB = new Set(handlesB.map((handle) => handle.nodeId))
    const peerIdsA = (await Promise.all(handlesA.map((handle) => connectedPeerIds(handle)))).flat()
    const peerIdsB = (await Promise.all(handlesB.map((handle) => connectedPeerIds(handle)))).flat()

    expect(peerIdsA.some((peerId) => nodeIdsB.has(peerId))).toBe(false)
    expect(peerIdsB.some((peerId) => nodeIdsA.has(peerId))).toBe(false)

    const key = `/api/phase6-room-${Date.now()}`
    await postRoomGossip(handlesA, key, 6001)
    await sleep(1500)

    const countsA = await Promise.all(handlesA.map((handle) => matchingGossipCount(handle, key)))
    const countsB = await Promise.all(handlesB.map((handle) => matchingGossipCount(handle, key)))
    expect(countsA.some((count) => count > 0)).toBe(true)
    expect(countsB.every((count) => count === 0)).toBe(true)
  } finally {
    await teardownNetwork([...handlesA, ...handlesB])
  }
})

test('DEMO-01b: product update reaches all 10 nodes with anti-entropy repair', async ({ browser }) => {
  test.setTimeout(180_000)
  const handles = await createNetwork(browser, 10)

  try {
    await waitForMesh(handles, 1, 30_000)
    const productId = `phase6-repair-${Date.now()}`
    const key = `/api/products/${productId}`

    for (const handle of handles) {
      expect(await fetchKey(handle, key)).toBe(200)
    }

    const invalidate = await handles[0].page.request.post(`http://localhost:3001/api/invalidate/api/products/${productId}`)
    expect(invalidate.ok()).toBe(true)
    const invalidation = await invalidate.json() as { newSeq: number }

    const seededNodeIds = await postRoomGossip(handles, key, invalidation.newSeq)
    expect(seededNodeIds.length).toBeGreaterThan(0)
    await sleep(3000)

    const repairResults = await Promise.all(handles.map((handle) => revalidateKey(handle, key)))
    expect(repairResults.every((result) => result.serverSeq === invalidation.newSeq)).toBe(true)

    const postRepairStates = await Promise.all(handles.map((handle) => getCacheState(handle, key)))
    expect(postRepairStates.every((state) => state.latestSeq >= invalidation.newSeq)).toBe(true)

    for (const handle of handles) {
      expect(await fetchKey(handle, key)).toBe(200)
    }

    const finalStates = await Promise.all(handles.map((handle) => getCacheState(handle, key)))
    expect(finalStates.every((state) => state.cachedSeq >= invalidation.newSeq)).toBe(true)
  } finally {
    await teardownNetwork(handles)
  }
})

test('DEMO-02: fallback hierarchy remains observable while components are disabled', async ({ browser }) => {
  test.setTimeout(180_000)
  const handles = await createNetwork(browser, 5)

  try {
    await waitForMesh(handles, 1, 30_000)

    const peerKey = `/api/products/phase6-fallback-peer-${Date.now()}`
    const peerCounts = await runPeerWorkload(handles, peerKey, 50)
    expect(peerCounts.server_fallback).toBeGreaterThan(0)
    expect(peerCounts.peer_fetch).toBeGreaterThan(0)
    expect(peerCounts.sw_cache).toBeGreaterThan(0)

    await Promise.all(handles.map((handle) => setRuntimeFlags(handle, { disableP2P: true })))
    const noP2PBefore = await aggregateLatencyCounts(handles)
    const noP2PKey = `/api/products/phase6-fallback-local-${Date.now()}`
    expect(await fetchKey(handles[0], noP2PKey)).toBe(200)
    expect(await fetchKey(handles[0], noP2PKey)).toBe(200)
    await handles[0].page.waitForTimeout(500)
    const noP2PAfter = await aggregateLatencyCounts(handles)
    expect(noP2PAfter.server_fallback).toBeGreaterThan(noP2PBefore.server_fallback)
    expect(noP2PAfter.sw_cache).toBeGreaterThan(noP2PBefore.sw_cache)

    await Promise.all(handles.map((handle) => setRuntimeFlags(handle, {
      disableP2P: true,
      disableCacheRead: true,
    })))
    const serverOnlyBefore = await aggregateLatencyCounts(handles)
    const serverOnlyKey = `/api/products/phase6-fallback-server-${Date.now()}`
    expect(await fetchKey(handles[0], serverOnlyKey)).toBe(200)
    expect(await fetchKey(handles[0], serverOnlyKey)).toBe(200)
    await handles[0].page.waitForTimeout(500)
    const serverOnlyAfter = await aggregateLatencyCounts(handles)
    expect(serverOnlyAfter.server_fallback).toBeGreaterThanOrEqual(serverOnlyBefore.server_fallback + 2)
  } finally {
    await teardownNetwork(handles)
  }
})

test('DEMO-03: metrics export writes paper-ready JSON and CSV summaries', async () => {
  const report = await readPhase5ReportOrFixture()
  const { jsonPath, csvPath } = await writeAcademicExport(report, 'test-results', 'phase-06-demo-metrics')

  const [json, csv] = await Promise.all([
    fs.readFile(jsonPath, 'utf8'),
    fs.readFile(csvPath, 'utf8'),
  ])

  expect(JSON.parse(json).cache_hit_rate.total_requests).toBeGreaterThan(0)
  expect(csv).toContain('section,metric,value')
  expect(csv).toContain('cache_hit_rate,p2p_hit_rate_pct')
  expect(csv).toContain('latency:peer_fetch,count')
})
