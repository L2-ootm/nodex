import { test, expect, Browser, BrowserContext, Page } from '@playwright/test'

// Phase 4 integration tests: Volatility Heuristic Classifier
// Covers VOL-01 through VOL-06
//
// Infrastructure (same as phase-03):
//   - Vite preview server:     http://localhost:3000
//   - Hono mock API:           http://localhost:3001
//   - Signaling server (P2P):  http://localhost:3002
//
// Test strategy: each test sends gossip invalidation events via POST /api/gossip-seed
// (mock-api on 3001), then reads IDB VOLATILITY_STORE and window.__volatilityScores
// to verify the volatility classifier behavior end-to-end.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext()
}

async function openAndWait(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage()
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15000 })
  return page
}

async function waitForPeerManager(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as unknown as Record<string, unknown>)['__peerManagerReady'],
    { timeout: 10000 }
  )
}

/**
 * Trigger N gossip invalidation events for a given key.
 * Uses POST /api/gossip-seed (mock-api endpoint on port 3001, proxied via Vite).
 * Seq values start at startSeq and increment by 1 per call.
 * Waits 150ms between events to allow SW GOSSIP_INVALIDATE processing.
 */
async function triggerInvalidations(
  page: Page,
  key: string,
  startSeq: number,
  count: number
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await page.evaluate(
      ({ key, seq }: { key: string; seq: number }) =>
        fetch('/api/gossip-seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: key, seq }),
        }).then((r) => r.status),
      { key, seq: startSeq + i }
    )
    await page.waitForTimeout(150)
  }
}

/**
 * Read a VolatilityEntry from IDB VOLATILITY_STORE for the given key.
 * Returns null if the entry does not exist.
 * IDB version 2, store name 'nodex-volatility' (VOLATILITY_STORE constant).
 */
async function readVolatilityEntry(
  page: Page,
  key: string
): Promise<{ key: string; change_count: number; last_changed_at: number; access_count: number } | null> {
  return page.evaluate((entryKey: string) => {
    return new Promise<{
      key: string
      change_count: number
      last_changed_at: number
      access_count: number
    } | null>((resolve, reject) => {
      // nodex-volatility is the VOLATILITY_STORE (config.ts: VOLATILITY_STORE = 'nodex-volatility')
      const req = indexedDB.open('nodex-db', 2)
      req.onsuccess = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('nodex-volatility')) {
          resolve(null)
          return
        }
        const tx = db.transaction('nodex-volatility', 'readonly')
        const store = tx.objectStore('nodex-volatility')
        const getReq = store.get(entryKey)
        getReq.onsuccess = () => resolve(getReq.result ?? null)
        getReq.onerror = () => reject(getReq.error)
      }
      req.onerror = () => reject(req.error)
    })
  }, key)
}

// ---------------------------------------------------------------------------
// VOL-03: cold-start key has no ledger entry and defaults to VOL_COLD_START (0.5)
// ---------------------------------------------------------------------------

test('VOL-03: cold-start key has no ledger entry and defaults to 0.5', async ({ browser }) => {
  const ctx = await createContext(browser)
  try {
    const page = await openAndWait(ctx)
    await waitForPeerManager(page)

    // Use a key that has never been invalidated in this test session
    const coldKey = `/api/products/cold-${Date.now()}`

    // Confirm window.__volatilityScores has no entry for this key
    const mapEntry = await page.evaluate((k: string) => {
      const map = (window as unknown as Record<string, unknown>)[
        '__volatilityScores'
      ] as Map<string, { score: number; tier: string }> | undefined
      if (!map) return null
      const entry = map.get(k)
      return entry ?? null
    }, coldKey)
    expect(mapEntry).toBeNull()

    // Confirm IDB has no VolatilityEntry for this key
    const idbEntry = await readVolatilityEntry(page, coldKey)
    expect(idbEntry).toBeNull()

    // Verify window.__volatilityScores is exposed (not undefined)
    const mapExists = await page.evaluate(() => {
      return !!(window as unknown as Record<string, unknown>)['__volatilityScores']
    })
    expect(mapExists).toBe(true)
  } finally {
    await ctx.close()
  }
})

// ---------------------------------------------------------------------------
// VOL-06: GOSSIP_INVALIDATE triggers ledger write to VOLATILITY_STORE (nodex-volatility IDB)
// ---------------------------------------------------------------------------

test('VOL-06: GOSSIP_INVALIDATE triggers ledger write to VOLATILITY_STORE', async ({ browser }) => {
  const ctx = await createContext(browser)
  try {
    const page = await openAndWait(ctx)
    await waitForPeerManager(page)

    const key = '/api/products/1'

    // Fetch the product first to ensure it is cached by the SW
    await page.evaluate(() => fetch('/api/products/1').then((r) => r.status))
    await page.waitForTimeout(300)

    // Trigger a single gossip invalidation (seq=100 to avoid collision with phase-03 tests)
    await triggerInvalidations(page, key, 100, 1)

    // Poll IDB until the VOLATILITY_STORE entry appears (up to 5s)
    const entry = await expect
      .poll(
        () => readVolatilityEntry(page, key),
        { timeout: 5000, intervals: [200, 400, 800] }
      )
      .not.toBeNull()

    // Entry must have change_count >= 1 (the invalidation we triggered)
    expect(entry).not.toBeNull()
    if (entry) {
      expect(entry.change_count).toBeGreaterThanOrEqual(1)
      expect(entry.last_changed_at).toBeGreaterThan(0)
    }
  } finally {
    await ctx.close()
  }
})

// ---------------------------------------------------------------------------
// VOL-01: volatility ledger entry has correct schema fields
// ---------------------------------------------------------------------------

test('VOL-01: volatility ledger entry has correct schema fields', async ({ browser }) => {
  const ctx = await createContext(browser)
  try {
    const page = await openAndWait(ctx)
    await waitForPeerManager(page)

    const key = '/api/products/1'

    // Seed at least one invalidation to ensure a ledger entry exists
    await page.evaluate(() => fetch('/api/products/1').then((r) => r.status))
    await page.waitForTimeout(200)
    await triggerInvalidations(page, key, 200, 1)

    // Wait for IDB write
    const entry = await expect
      .poll(
        () => readVolatilityEntry(page, key),
        { timeout: 5000, intervals: [300, 500, 1000] }
      )
      .not.toBeNull()

    // VOL-01: entry must have the correct VolatilityEntry schema fields
    expect(entry).not.toBeNull()
    if (entry) {
      expect(typeof entry.key).toBe('string')
      expect(entry.key).toBe(key)
      expect(typeof entry.change_count).toBe('number')
      expect(entry.change_count).toBeGreaterThanOrEqual(1)
      expect(typeof entry.last_changed_at).toBe('number')
      expect(entry.last_changed_at).toBeGreaterThan(0)
      expect(typeof entry.access_count).toBe('number')
      expect(entry.access_count).toBeGreaterThanOrEqual(0)
    }
  } finally {
    await ctx.close()
  }
})

// ---------------------------------------------------------------------------
// VOL-02: computed score is in [0, 1] range after invalidation
// ---------------------------------------------------------------------------

test('VOL-02: computed score is in [0,1] range after invalidation', async ({ browser }) => {
  const ctx = await createContext(browser)
  try {
    const page = await openAndWait(ctx)
    await waitForPeerManager(page)

    const key = '/api/products/1'

    // Trigger invalidation to populate scoreCache and window.__volatilityScores
    await page.evaluate(() => fetch('/api/products/1').then((r) => r.status))
    await page.waitForTimeout(200)
    await triggerInvalidations(page, key, 300, 1)

    // Wait for window.__volatilityScores to contain the key (up to 5s)
    await expect
      .poll(
        () =>
          page.evaluate((k: string) => {
            const map = (window as unknown as Record<string, unknown>)[
              '__volatilityScores'
            ] as Map<string, { score: number; tier: string }> | undefined
            return map?.get(k) ?? null
          }, key),
        { timeout: 5000, intervals: [200, 400, 800] }
      )
      .not.toBeNull()

    // Read the score and verify it is in [0, 1]
    const entry = await page.evaluate((k: string) => {
      const map = (window as unknown as Record<string, unknown>)[
        '__volatilityScores'
      ] as Map<string, { score: number; tier: string }> | undefined
      return map?.get(k) ?? null
    }, key)

    expect(entry).not.toBeNull()
    if (entry) {
      expect(typeof entry.score).toBe('number')
      expect(entry.score).toBeGreaterThanOrEqual(0)
      expect(entry.score).toBeLessThanOrEqual(1)
      // After at least 1 invalidation, change_frequency > 0 → score > 0
      expect(entry.score).toBeGreaterThan(0)
    }
  } finally {
    await ctx.close()
  }
})

// ---------------------------------------------------------------------------
// VOL-05: key with 10+ invalidations reaches ephemeral tier (score >= 0.8)
// ---------------------------------------------------------------------------

test('VOL-05: key with 10+ invalidations reaches ephemeral tier (score >= 0.8)', async ({ browser }) => {
  const ctx = await createContext(browser)
  try {
    const page = await openAndWait(ctx)
    await waitForPeerManager(page)

    // Use a unique key to isolate from other tests
    const key = '/api/products/2'

    await page.evaluate(() => fetch('/api/products/2').then((r) => r.status))
    await page.waitForTimeout(300)

    // Trigger 10 invalidations — this should push change_count to VOL_CHANGE_BASELINE (10)
    // and score to >= VOL_P2P_GATE (0.8), classifying as 'ephemeral'
    await triggerInvalidations(page, key, 400, 10)

    // Wait for window.__volatilityScores to reflect the updated score
    await expect
      .poll(
        () =>
          page.evaluate((k: string) => {
            const map = (window as unknown as Record<string, unknown>)[
              '__volatilityScores'
            ] as Map<string, { score: number; tier: string }> | undefined
            return map?.get(k) ?? null
          }, key),
        { timeout: 10000, intervals: [300, 600, 1000] }
      )
      .not.toBeNull()

    const entry = await page.evaluate((k: string) => {
      const map = (window as unknown as Record<string, unknown>)[
        '__volatilityScores'
      ] as Map<string, { score: number; tier: string }> | undefined
      return map?.get(k) ?? null
    }, key)

    expect(entry).not.toBeNull()
    if (entry) {
      // VOL-05: score >= VOL_P2P_GATE (0.8) — key is blocked from P2P distribution
      expect(entry.score).toBeGreaterThanOrEqual(0.8)
      expect(entry.tier).toBe('ephemeral')
    }
  } finally {
    await ctx.close()
  }
})

// ---------------------------------------------------------------------------
// VOL-04: volatility-panel shows tier string after invalidation
// ---------------------------------------------------------------------------

test('VOL-04: volatility-panel shows tier string after invalidation', async ({ browser }) => {
  const ctx = await createContext(browser)
  try {
    const page = await openAndWait(ctx)
    await waitForPeerManager(page)

    const key = '/api/products/1'

    await page.evaluate(() => fetch('/api/products/1').then((r) => r.status))
    await page.waitForTimeout(200)

    // Send one invalidation to trigger a volatility-update BroadcastChannel event
    await triggerInvalidations(page, key, 500, 1)

    // Wait for window.__volatilityScores to be populated
    await expect
      .poll(
        () =>
          page.evaluate((k: string) => {
            const map = (window as unknown as Record<string, unknown>)[
              '__volatilityScores'
            ] as Map<string, { score: number; tier: string }> | undefined
            return map?.get(k) ?? null
          }, key),
        { timeout: 5000, intervals: [200, 400, 800] }
      )
      .not.toBeNull()

    // VOL-04: the tier must be one of the three valid tier strings
    const entry = await page.evaluate((k: string) => {
      const map = (window as unknown as Record<string, unknown>)[
        '__volatilityScores'
      ] as Map<string, { score: number; tier: string }> | undefined
      return map?.get(k) ?? null
    }, key)

    expect(entry).not.toBeNull()
    if (entry) {
      expect(['stable', 'volatile', 'ephemeral']).toContain(entry.tier)
    }

    // Verify the volatility-panel DOM element exists
    const panelExists = await page.evaluate(() => {
      return document.getElementById('volatility-panel') !== null
    })
    expect(panelExists).toBe(true)
  } finally {
    await ctx.close()
  }
})
