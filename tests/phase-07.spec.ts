import { expect, test, type Browser, type Page } from '@playwright/test'
import * as fs from 'fs/promises'
import {
  createNetwork,
  joinNetworkNode,
  openNodePage,
  teardownNetwork,
  waitForMesh,
  waitForPeerManager,
  type NodeHandle,
} from './helpers/harness'
import {
  buildExternalValidationReport,
  writeExternalValidationExport,
  type EvidenceStatus,
  type ExternalValidationReport,
  type PeerTelemetrySample,
} from './helpers/report-writer'

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

async function collectStoragePressure(page: Page): Promise<{ usage_ratio: number | null; quota_bytes: number | null }> {
  return page.evaluate(async () => {
    const fn = (window as unknown as Record<string, unknown>)['__nodexStoragePressure']
    if (typeof fn !== 'function') throw new Error('__nodexStoragePressure hook missing')
    return await (fn as () => Promise<{ usage_ratio: number | null; quota_bytes: number | null }>)()
  })
}

async function openTwoTabs(browser: Browser, roomId: string): Promise<{ pages: Page[]; close: () => Promise<void> }> {
  const ctx = await browser.newContext()
  const first = await openNodePage(ctx, roomId)
  await waitForPeerManager(first)
  const second = await openNodePage(ctx, roomId)
  await waitForPeerManager(second)

  return {
    pages: [first, second],
    close: () => ctx.close(),
  }
}

async function postRoomGossip(handles: NodeHandle[], key: string, seq: number): Promise<void> {
  const response = await handles[0].page.request.post('http://localhost:3001/api/gossip-seed', {
    data: { path: key, seq, room: handles[0].roomId },
    headers: { 'Content-Type': 'application/json' },
  })
  expect(response.ok()).toBe(true)
}

async function matchingGossipCount(handle: NodeHandle, key: string): Promise<number> {
  return handle.page.evaluate((eventKey) => {
    const events = (window as unknown as Record<string, unknown>)['__gossipEvents'] as
      | Record<string, unknown>[]
      | undefined
    return (events ?? []).filter((event) => event['key'] === eventKey).length
  }, key)
}

test('EXT-03/EXT-04: loopback network exports WebRTC edge telemetry schema', async ({ browser }) => {
  test.setTimeout(120_000)
  const handles = await createNetwork(browser, 3, { topologyLabel: 'loopback' })

  try {
    await waitForMesh(handles, 1, 30_000)
    const samples = (await Promise.all(handles.map((handle) => collectTelemetry(handle.page)))).flat()

    expect(samples.length).toBeGreaterThan(0)
    for (const sample of samples) {
      expect(sample.room_id).toBe(handles[0].roomId)
      expect(sample.topology_label).toBe('loopback')
      expect(['host', 'srflx', 'relay', 'unknown']).toContain(sample.selected_candidate_type)
      expect(['connected', 'connecting', 'disconnected', 'failed', 'closed', 'new']).toContain(sample.connection_state)
      expect(typeof sample.timestamp).toBe('number')
    }
  } finally {
    await teardownNetwork(handles)
  }
})

test('EXT-07: browser storage pressure hook reports estimate without blocking cache behavior', async ({ browser }) => {
  test.setTimeout(60_000)
  const handles = await createNetwork(browser, 1, { topologyLabel: 'loopback-storage' })

  try {
    const sample = await collectStoragePressure(handles[0].page)
    expect(sample).toHaveProperty('usage_ratio')
    expect(sample).toHaveProperty('quota_bytes')
    if (sample.usage_ratio !== null) {
      expect(sample.usage_ratio).toBeGreaterThanOrEqual(0)
      expect(sample.usage_ratio).toBeLessThanOrEqual(1)
    }
  } finally {
    await teardownNetwork(handles)
  }
})

test('EXT-06: two tabs in one browser profile expose exactly one active P2P leader', async ({ browser }) => {
  test.setTimeout(60_000)
  const roomId = `phase7-tabs-${Date.now()}`
  const session = await openTwoTabs(browser, roomId)

  try {
    const states = await Promise.all(session.pages.map((page) => leadershipState(page)))
    expect(states.filter((state) => state.isLeader)).toHaveLength(1)
    expect(states.filter((state) => state.role === 'follower')).toHaveLength(1)
  } finally {
    await session.close()
  }
})

test('EXT-05: churned node can rejoin the same room and export fresh telemetry', async ({ browser }) => {
  test.setTimeout(150_000)
  const handles = await createNetwork(browser, 3, { topologyLabel: 'loopback-churn' })
  let joined: NodeHandle | null = null

  try {
    await waitForMesh(handles, 1, 30_000)
    await handles[1].ctx.close()

    joined = await joinNetworkNode(browser, handles[0].roomId, { topologyLabel: 'loopback-churn' })
    const active = [handles[0], handles[2], joined]
    await waitForMesh(active, 1, 45_000)

    const key = `/api/products/phase7-churn-${Date.now()}`
    await postRoomGossip(active, key, 7101)
    await joined.page.waitForTimeout(1000)
    const counts = await Promise.all(active.map((handle) => matchingGossipCount(handle, key)))
    expect(counts.some((count) => count > 0)).toBe(true)
    expect(await joined.page.evaluate((path) => fetch(path).then((response) => response.status), key)).toBe(200)

    const samples = await collectTelemetry(joined.page)
    expect(samples.some((sample) => sample.connection_state === 'connected')).toBe(true)
  } finally {
    const remaining = [handles[0], handles[2]]
    if (joined) remaining.push(joined)
    await teardownNetwork(remaining)
  }
})

test('EXT-04/EXT-09: Phase 7 report writes claim-gated JSON and CSV artifacts', async ({ browser }) => {
  test.setTimeout(90_000)
  const handles = await createNetwork(browser, 2, { topologyLabel: 'loopback-report' })
  await waitForMesh(handles, 1, 30_000)
  const edgeTelemetry = (await Promise.all(handles.map((handle) => collectTelemetry(handle.page)))).flat()

  const report: ExternalValidationReport = buildExternalValidationReport({
    timestamp: new Date().toISOString(),
    topology_label: 'loopback',
    evidence: {
      loopback: { status: 'pass', notes: 'Automated loopback telemetry collected' },
      lan_multi_machine: { status: 'not_measured', notes: 'Manual run required' },
      wan_nat: { status: 'not_measured', notes: 'Manual run required' },
      turn_relay: { status: 'not_measured', notes: 'TURN credentials/manual run required' },
      churn: { status: 'pass', notes: 'Local rejoin tested' },
      background_tab: { status: 'not_measured', notes: 'Manual browser lifecycle run required' },
      mobile_browser: { status: 'not_measured', notes: 'Manual mobile browser run required' },
      storage_pressure: { status: 'partial', notes: 'Unit LRU/quota path covered; browser eviction manual' },
      multi_tab_coordination: { status: 'pass', notes: 'Single active P2P leader tested' },
      geographic_long_range: { status: 'not_measured', notes: 'GOSP-06 remains pending' },
    } satisfies Record<string, { status: EvidenceStatus; notes: string }>,
    edgeTelemetry,
  })

  try {
    const { jsonPath, csvPath } = await writeExternalValidationExport(report)
    const [json, csv] = await Promise.all([fs.readFile(jsonPath, 'utf8'), fs.readFile(csvPath, 'utf8')])
    const parsed = JSON.parse(json) as ExternalValidationReport

    expect(parsed.summary.not_measured).toBeGreaterThan(0)
    expect(parsed.edge_telemetry.length).toBeGreaterThan(0)
    expect(csv).toContain('evidence:geographic_long_range,status,not_measured')
    expect(csv).toContain('summary,pass,3')
    expect(csv).toContain('edge:0,selected_candidate_type')
  } finally {
    await teardownNetwork(handles)
  }
})
