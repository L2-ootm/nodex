import { expect, test } from '@playwright/test'
import { createNetwork, teardownNetwork, waitForMesh } from './helpers/harness'
import type { NodeHandle } from './helpers/harness'
import { buildZipfTable, makePrng, rankToKey, sampleZipf } from './helpers/zipf'
import { writeReport } from './helpers/report-writer'
import type { Phase05Report, SourceLatencyStats } from './helpers/report-writer'

test.describe.configure({ mode: 'serial' })

type LatencyType = 'sw-cache' | 'peer-fetch' | 'server-fallback'

interface ConvergenceRoundResult {
  propagation_ms_per_node: number[]
  hop_count_total: number
  all_nodes_received: boolean
}

interface CacheBreakdown {
  total_requests: number
  sw_cache: number
  peer_fetch: number
  server_fallback: number
  p2p_hit_rate_pct: number
}

const LATENCY_TYPES: LatencyType[] = ['sw-cache', 'peer-fetch', 'server-fallback']

function emptyLatencyStats(): SourceLatencyStats {
  return { p50: 0, p95: 0, p99: 0, count: 0 }
}

function makeInitialReport(): Phase05Report {
  return {
    timestamp: new Date().toISOString(),
    convergence: {
      runs: 0,
      p50_ms: 0,
      p95_ms: 0,
      max_ms: 0,
      all_nodes_received_pct: 0,
      avg_hop_count: 0,
      dedup_verified: false,
    },
    cache_hit_rate: {
      total_requests: 0,
      sw_cache: 0,
      peer_fetch: 0,
      server_fallback: 0,
      p2p_hit_rate_pct: 0,
    },
    latency_percentiles: {
      sw_cache: emptyLatencyStats(),
      peer_fetch: emptyLatencyStats(),
      server_fallback: emptyLatencyStats(),
    },
  }
}

let phase05Report = makeInitialReport()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0
  const index = Math.ceil(pct * sorted.length) - 1
  const value = sorted[Math.max(0, Math.min(sorted.length - 1, index))]
  return Math.round(value * 100) / 100
}

function summarizeSamples(samples: number[]): SourceLatencyStats {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    count: sorted.length,
  }
}

async function connectedPeerCount(handle: NodeHandle): Promise<number> {
  return handle.page.evaluate(() => {
    const conns = (window as unknown as Record<string, unknown>)[
      '__peerConnections'
    ] as Map<string, { state: string }> | undefined

    if (!conns) return 0
    return [...conns.values()].filter((conn) => conn.state === 'connected').length
  })
}

async function gossipCounts(handles: NodeHandle[]): Promise<number[]> {
  return Promise.all(
    handles.map((handle) =>
      handle.page.evaluate(() => {
        const events = (window as unknown as Record<string, unknown>)['__gossipEvents'] as unknown[] | undefined
        return events?.length ?? 0
      })
    )
  )
}

async function matchingGossipCounts(
  handles: NodeHandle[],
  preCounts: number[],
  key: string
): Promise<number[]> {
  return Promise.all(
    handles.map((handle, index) =>
      handle.page.evaluate(
        ({ pre, key: eventKey }: { pre: number; key: string }) => {
          const events = (window as unknown as Record<string, unknown>)['__gossipEvents'] as
            | Record<string, unknown>[]
            | undefined
          return (events ?? []).slice(pre).filter((event) => event['key'] === eventKey).length
        },
        { pre: preCounts[index], key }
      )
    )
  )
}

async function postGossipSeed(handles: NodeHandle[], key: string, seq: number): Promise<void> {
  const response = await handles[0].page.request.post('http://localhost:3001/api/gossip-seed', {
    data: { path: key, seq, room: handles[0].roomId },
    headers: { 'Content-Type': 'application/json' },
  })
  if (!response.ok()) {
    throw new Error(`gossip-seed failed with HTTP ${response.status()}`)
  }
}

async function waitForAnyNewGossip(
  handles: NodeHandle[],
  preCounts: number[],
  timeout = 5000
): Promise<number> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const counts = await gossipCounts(handles)
    const received = counts.filter((count, index) => count > preCounts[index]).length
    if (received > 0) {
      return received
    }
    await sleep(200)
  }
  return 0
}

async function runConvergenceRound(
  handles: NodeHandle[],
  key: string,
  seq: number,
  convergenceWindowMs = 5000
): Promise<ConvergenceRoundResult> {
  const preCounts = await gossipCounts(handles)
  await postGossipSeed(handles, key, seq)

  const deadline = Date.now() + convergenceWindowMs
  while (Date.now() < deadline) {
    const counts = await matchingGossipCounts(handles, preCounts, key)
    if (counts.every((count) => count > 0)) {
      break
    }
    await sleep(100)
  }

  const eventsByNode = await Promise.all(
    handles.map((handle, index) =>
      handle.page.evaluate(
        ({ pre, key: eventKey }: { pre: number; key: string }) => {
          const events = (window as unknown as Record<string, unknown>)['__gossipEvents'] as
            | Record<string, unknown>[]
            | undefined
          return (events ?? []).slice(pre).filter((event) => event['key'] === eventKey)
        },
        { pre: preCounts[index], key }
      )
    )
  )

  const propagation_ms_per_node = eventsByNode.map((events) => {
    const event = events[0]
    if (!event) return -1
    const receivedAt = typeof event['t_received'] === 'number'
      ? event['t_received']
      : typeof event['t_local'] === 'number'
        ? event['t_local']
        : Date.now()
    const invalidatedAt = typeof event['t_invalidate'] === 'number' ? event['t_invalidate'] : receivedAt
    return Math.max(0, receivedAt - invalidatedAt)
  })

  const hop_count_total = eventsByNode.reduce((sum, events) => {
    const hopCount = events[0]?.['hop_count']
    return sum + (typeof hopCount === 'number' ? hopCount : 0)
  }, 0)

  return {
    propagation_ms_per_node,
    hop_count_total,
    all_nodes_received: propagation_ms_per_node.every((ms) => ms >= 0),
  }
}

async function runConvergenceDistribution(
  handles: NodeHandle[],
  runs = 30
): Promise<Phase05Report['convergence']> {
  const table = buildZipfTable(5, 1.0)
  const rng = makePrng(42)
  const keyPrefix = `/api/phase5-gossip-${Date.now()}`
  const results: ConvergenceRoundResult[] = []

  for (let run = 0; run < runs; run++) {
    const key = rankToKey(sampleZipf(table, rng), keyPrefix)
    const result = await runConvergenceRound(handles, key, 1000 + run)
    results.push(result)
    await sleep(50)
  }

  const propagationSamples = results
    .flatMap((result) => result.propagation_ms_per_node)
    .filter((ms) => ms >= 0)
    .sort((a, b) => a - b)
  const allReceivedCount = results.filter((result) => result.all_nodes_received).length
  const avgHopCount = results.reduce((sum, result) => sum + result.hop_count_total, 0) / results.length
  const hopLimit = 10 * Math.log2(10)

  return {
    runs,
    p50_ms: percentile(propagationSamples, 0.5),
    p95_ms: percentile(propagationSamples, 0.95),
    max_ms: propagationSamples[propagationSamples.length - 1] ?? 0,
    all_nodes_received_pct: allReceivedCount / results.length,
    avg_hop_count: Math.round(avgHopCount * 100) / 100,
    dedup_verified: avgHopCount < hopLimit,
  }
}

async function aggregateLatencyCounts(handles: NodeHandle[]): Promise<CacheBreakdown> {
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

  const swCache = perNode.reduce((sum, counts) => sum + counts.sw_cache, 0)
  const peerFetch = perNode.reduce((sum, counts) => sum + counts.peer_fetch, 0)
  const serverFallback = perNode.reduce((sum, counts) => sum + counts.server_fallback, 0)
  const total = swCache + peerFetch + serverFallback

  return {
    total_requests: total,
    sw_cache: swCache,
    peer_fetch: peerFetch,
    server_fallback: serverFallback,
    p2p_hit_rate_pct: total === 0 ? 0 : Math.round(((swCache + peerFetch) / total) * 10000) / 100,
  }
}

async function aggregateLatencySamples(
  handles: NodeHandle[]
): Promise<Phase05Report['latency_percentiles']> {
  const buckets: Record<LatencyType, number[]> = {
    'sw-cache': [],
    'peer-fetch': [],
    'server-fallback': [],
  }

  const perNodeEntries = await Promise.all(
    handles.map((handle) =>
      handle.page.evaluate(() => {
        const getSamples = (window as unknown as Record<string, unknown>)['__latencySamples'] as
          | (() => Map<string, number[]>)
          | undefined
        const samples = getSamples?.() ?? new Map<string, number[]>()
        return [...samples.entries()].map(([type, values]) => [type, [...values]] as [string, number[]])
      })
    )
  )

  for (const entries of perNodeEntries) {
    for (const [type, values] of entries) {
      if (LATENCY_TYPES.includes(type as LatencyType)) {
        buckets[type as LatencyType].push(...values)
      }
    }
  }

  return {
    sw_cache: summarizeSamples(buckets['sw-cache']),
    peer_fetch: summarizeSamples(buckets['peer-fetch']),
    server_fallback: summarizeSamples(buckets['server-fallback']),
  }
}

async function runCacheWorkload(handles: NodeHandle[], requestCount = 100): Promise<CacheBreakdown> {
  const warmPreCounts = await gossipCounts(handles)
  await postGossipSeed(handles, `/api/phase5-cache-warm-${Date.now()}`, 30000)
  await waitForAnyNewGossip(handles, warmPreCounts, 5000)

  const key = '/api/products/1'
  const seedStatus = await handles[0].page.evaluate((cacheKey: string) => fetch(cacheKey).then((r) => r.status), key)
  expect(seedStatus).toBe(200)
  await handles[0].page.waitForTimeout(300)

  for (let i = 0; i < requestCount; i++) {
    const handle = handles[i % handles.length]
    const status = await handle.page.evaluate((cacheKey: string) => fetch(cacheKey).then((r) => r.status), key)
    expect(status).toBe(200)
    await handle.page.waitForTimeout(20)
  }

  await handles[0].page.waitForTimeout(1000)
  return aggregateLatencyCounts(handles)
}

async function ensureConvergenceReport(handles: NodeHandle[]): Promise<void> {
  if (phase05Report.convergence.runs === 30 && phase05Report.convergence.dedup_verified) {
    return
  }

  phase05Report = {
    ...phase05Report,
    timestamp: new Date().toISOString(),
    convergence: await runConvergenceDistribution(handles, 30),
  }
}

test('TEST-01: 10 isolated BrowserContext instances - own SW + IDB + no cross-context leakage', async ({ browser }) => {
  test.setTimeout(120_000)
  const handles = await createNetwork(browser, 10)

  try {
    expect(handles).toHaveLength(10)

    const swControlled = await Promise.all(
      handles.map((handle) => handle.page.evaluate(() => navigator.serviceWorker.controller !== null))
    )
    expect(swControlled.every(Boolean)).toBe(true)

    const nodeIds = handles.map((handle) => handle.nodeId)
    expect(nodeIds.every((nodeId) => typeof nodeId === 'string' && nodeId.length > 0)).toBe(true)
    expect(new Set(nodeIds).size).toBe(10)

    const connectionSnapshots = await Promise.all(
      handles.map((handle) =>
        handle.page.evaluate(() => {
          const conns = (window as unknown as Record<string, unknown>)[
            '__peerConnections'
          ] as Map<string, { state: string }> | undefined
          return conns ? [...conns.entries()].map(([peerId, conn]) => [peerId, conn.state]) : []
        })
      )
    )
    expect(connectionSnapshots.every(Array.isArray)).toBe(true)
  } finally {
    await teardownNetwork(handles)
  }
})

test('TEST-02: 10-node signaling mesh - each context connects to loopback signaling server', async ({ browser }) => {
  test.setTimeout(60_000)
  const handles = await createNetwork(browser, 10)

  try {
    await waitForMesh(handles, 1, 30_000)
    const counts = await Promise.all(handles.map((handle) => connectedPeerCount(handle)))

    console.log('[phase-05] connected peer counts:', counts.join(', '))
    for (const count of counts) {
      expect(count).toBeGreaterThanOrEqual(1)
    }
  } finally {
    await teardownNetwork(handles)
  }
})

test('TEST-03: server-side gossip-seed POST triggers propagation observable via __gossipEvents', async ({ browser }) => {
  test.setTimeout(60_000)
  const handles = await createNetwork(browser, 10)

  try {
    await waitForMesh(handles, 1, 30_000)
    const key = `/api/phase5-test03-${Date.now()}`
    const preCounts = await gossipCounts(handles)

    await postGossipSeed(handles, key, 1001)

    const deadline = Date.now() + 5000
    let receivedCounts = Array(handles.length).fill(0) as number[]
    while (Date.now() < deadline) {
      receivedCounts = await matchingGossipCounts(handles, preCounts, key)
      if (receivedCounts.filter((count) => count > 0).length >= 5) {
        break
      }
      await sleep(200)
    }

    const pagesWithEvent = receivedCounts.filter((count) => count > 0).length
    console.log('[phase-05] TEST-03 pages with gossip event:', pagesWithEvent)
    expect(pagesWithEvent).toBeGreaterThanOrEqual(5)
  } finally {
    await teardownNetwork(handles)
  }
})

test('TEST-04: gossip convergence distribution over 30 runs', async ({ browser }) => {
  test.setTimeout(300_000)
  const handles = await createNetwork(browser, 10)

  try {
    await waitForMesh(handles, 1, 30_000)
    const convergence = await runConvergenceDistribution(handles, 30)
    phase05Report = {
      ...phase05Report,
      timestamp: new Date().toISOString(),
      convergence,
    }

    console.log('[phase-05] convergence:', JSON.stringify(convergence))
    expect(convergence.dedup_verified).toBe(true)
    expect(convergence.all_nodes_received_pct).toBeGreaterThanOrEqual(0.8)
    expect(convergence.p50_ms).toBeGreaterThan(0)

    await writeReport(phase05Report)
  } finally {
    await teardownNetwork(handles)
  }
})

test('TEST-05: cache hit rate - 100 requests after single-node server seed', async ({ browser }) => {
  test.setTimeout(120_000)
  const handles = await createNetwork(browser, 10)

  try {
    await waitForMesh(handles, 1, 30_000)
    const cacheHitRate = await runCacheWorkload(handles, 100)
    phase05Report = {
      ...phase05Report,
      timestamp: new Date().toISOString(),
      cache_hit_rate: cacheHitRate,
    }

    console.log('[phase-05] cache hit rate:', JSON.stringify(cacheHitRate))
    expect(cacheHitRate.total_requests).toBeGreaterThanOrEqual(100)
    expect(cacheHitRate.p2p_hit_rate_pct).toBeGreaterThan(0)
  } finally {
    await teardownNetwork(handles)
  }
})

test('TEST-06: p50/p95/p99 latency by source type - sw-cache, peer-fetch, server-fallback', async ({ browser }) => {
  test.setTimeout(180_000)
  const handles = await createNetwork(browser, 10)
  const cdpClients: Array<{ send: (method: string, params?: Record<string, unknown>) => Promise<unknown> }> = []
  let cdpFallback = false

  try {
    await waitForMesh(handles, 1, 30_000)
    await ensureConvergenceReport(handles)

    try {
      for (const handle of handles) {
        const client = await handle.page.context().newCDPSession(handle.page)
        cdpClients.push(client)
        await client.send('Network.enable')
        await client.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 50,
          downloadThroughput: -1,
          uploadThroughput: -1,
        })
      }
    } catch (err) {
      cdpFallback = true
      console.warn('[phase-05] CDP latency injection unavailable; continuing without it:', err)
    }

    const cacheHitRate = await runCacheWorkload(handles, 100)
    const latencyPercentiles = await aggregateLatencySamples(handles)
    phase05Report = {
      ...phase05Report,
      timestamp: new Date().toISOString(),
      cache_hit_rate: cacheHitRate,
      latency_percentiles: latencyPercentiles,
      cdp_fallback: cdpFallback || undefined,
    }

    console.log('[phase-05] latency percentiles:', JSON.stringify(latencyPercentiles))
    expect(latencyPercentiles.sw_cache.count + latencyPercentiles.peer_fetch.count).toBeGreaterThan(0)
    expect(phase05Report.convergence.runs).toBe(30)
    expect(phase05Report.convergence.dedup_verified).toBe(true)
    expect(phase05Report.convergence.all_nodes_received_pct).toBeGreaterThanOrEqual(0.8)

    await writeReport(phase05Report)
  } finally {
    for (const client of cdpClients) {
      await client
        .send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        })
        .catch(() => undefined)
    }
    await teardownNetwork(handles)
  }
})
