// tests/sw-freshness.spec.ts — SW-05
// Verifies: a cache entry whose seq is behind the latest observed seq triggers server fallback.
//
// The MetricsEvent type ('server-fallback' vs 'sw-cache') is the observable indicator
// of whether the SW went to the network. page.on('request') does not reliably capture
// SW-initiated fetches, so we use MetricsEvent assertions throughout.

import { test, expect } from '@playwright/test'
import { injectMetricsCapture, waitForMetricsEvent } from './helpers/metrics-capture'

test.describe('SW-05: freshness — seq-based staleness detection', () => {
  // Use a product ID unique to this test worker to avoid cross-test seq counter pollution
  let productId: string

  test.beforeEach(async ({ page }) => {
    // Generate a unique product ID per test run based on timestamp + random
    productId = `sw05-${Date.now()}-${Math.floor(Math.random() * 10000)}`
    await page.goto('/')
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15000 })
    await page.evaluate(() => caches.delete('nodex-v1'))
    await page.waitForTimeout(200)
  })

  test('stale seq triggers server fallback and emits server-fallback MetricsEvent', async ({ page }) => {
    await injectMetricsCapture(page)
    const key = `/api/products/${productId}`

    // Step 1: First fetch — seeds cache and in-memory seq map (server starts at seq=1)
    await page.evaluate((k) => fetch(k), key)
    await waitForMetricsEvent(
      page,
      (e) => e.type === 'server-fallback' && e.key === key
    )
    await page.waitForTimeout(300)

    // Step 2: Confirm the entry is cached (second fetch = sw-cache)
    await page.evaluate(() => {
      const w = window as Window & { __capturedMetrics?: unknown[] }
      w.__capturedMetrics = []
    })
    await page.evaluate((k) => fetch(k), key)
    const cacheHitEvent = await waitForMetricsEvent(
      page,
      (e) => e.type === 'sw-cache' && e.key === key
    )
    expect(cacheHitEvent.type).toBe('sw-cache')

    // Step 3: Bump server seq to +1 via POST /api/invalidate
    // productId format: "sw05-<timestamp>-<rand>" → path is "/api/products/sw05-..."
    const invalidatePath = `api/products/${productId}` // without leading slash for the route param
    const inv = await page.evaluate(async (p) => {
      const r = await fetch(`http://localhost:3001/api/invalidate/${p}`, {
        method: 'POST',
        body: '',
      })
      return r.json()
    }, invalidatePath)
    // Server was at seq=1 (first GET set it), now newSeq=2
    expect(inv.newSeq).toBe(2)

    // Step 4: Verify server seq via introspection endpoint
    const seqCheck = await page.evaluate(async (p) => {
      const r = await fetch(`http://localhost:3001/api/__test__/seq/${p}`)
      return r.json()
    }, invalidatePath)
    expect(seqCheck.seq).toBe(2)

    // Step 5: Clear Cache Storage — forces a cache miss on the next request
    await page.evaluate(() => caches.delete('nodex-v1'))
    await page.waitForTimeout(200)

    // Reset captured metrics
    await page.evaluate(() => {
      const w = window as Window & { __capturedMetrics?: unknown[] }
      w.__capturedMetrics = []
    })

    // Step 6: Fetch again — cache miss → SW goes to server → emits server-fallback
    await page.evaluate((k) => fetch(k), key)

    // Verify server-fallback MetricsEvent emitted (proves SW went to server, not cache)
    const fallbackEvent = await waitForMetricsEvent(
      page,
      (e) => e.type === 'server-fallback' && e.key === key
    )
    expect(fallbackEvent.schema_version).toBe(1)
    expect(fallbackEvent.type).toBe('server-fallback')
    expect(typeof fallbackEvent.latency_ms).toBe('number')
    expect(fallbackEvent.latency_ms).toBeGreaterThanOrEqual(0)

    // Step 7: Self-seed confirmed — next fetch should be cache hit
    await page.waitForTimeout(300)
    await page.evaluate(() => {
      const w = window as Window & { __capturedMetrics?: unknown[] }
      w.__capturedMetrics = []
    })
    await page.evaluate((k) => fetch(k), key)
    const cacheHitAfterReseed = await waitForMetricsEvent(
      page,
      (e) => e.type === 'sw-cache' && e.key === key
    )
    expect(cacheHitAfterReseed.type).toBe('sw-cache')
  })
})
