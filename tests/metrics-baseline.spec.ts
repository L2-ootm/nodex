// tests/metrics-baseline.spec.ts — METR-06
// Verifies: server-fallback latency (first request, cold path) is measurably higher
// than sw-cache latency (second request, cached path) in the same browser session.

import { test, expect } from '@playwright/test'
import { injectMetricsCapture, waitForMetricsEvent } from './helpers/metrics-capture'

test.describe('METR-06: baseline latency comparison', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/metrics.html')
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15000 })
    await page.evaluate(() => caches.delete('nodex-v1'))
    await page.waitForTimeout(200)
    await injectMetricsCapture(page)
    await page.waitForTimeout(300)
    // Clear any flushed buffered events from prior runs
    await page.evaluate(() => {
      const w = window as Window & { __capturedMetrics?: unknown[] }
      w.__capturedMetrics = []
    })
  })

  test('server-fallback latency is measurably higher than sw-cache latency in same session', async ({ page }) => {
    // ---- Baseline path: cold start, no cache ----
    await page.evaluate(() => fetch('/api/products/77'))

    const fallbackEvent = await waitForMetricsEvent(
      page,
      (e) => e.type === 'server-fallback' && e.key === '/api/products/77'
    )
    const baselineLatency = fallbackEvent.latency_ms

    // Verify baseline latency is a valid number
    expect(typeof baselineLatency).toBe('number')
    expect(baselineLatency).toBeGreaterThanOrEqual(0)

    // Give SW time to write cache entry
    await page.waitForTimeout(300)

    // Reset metrics to isolate the cache hit measurement
    await page.evaluate(() => {
      const w = window as Window & { __capturedMetrics?: unknown[] }
      w.__capturedMetrics = []
    })

    // ---- Cached path: same product ID, served from SW cache ----
    await page.evaluate(() => fetch('/api/products/77'))

    const cacheEvent = await waitForMetricsEvent(
      page,
      (e) => e.type === 'sw-cache' && e.key === '/api/products/77'
    )
    const cachedLatency = cacheEvent.latency_ms

    // Verify cached latency is a valid number
    expect(typeof cachedLatency).toBe('number')
    expect(cachedLatency).toBeGreaterThanOrEqual(0)

    // METR-06: server-fallback latency > sw-cache latency
    // (loose assertion — avoids CI timing flakiness on loopback networks)
    // The server path includes a real HTTP round trip to localhost:3001 plus
    // IDB writes; the cache path is a Cache Storage lookup with no network.
    expect(baselineLatency).toBeGreaterThan(cachedLatency)

    // Additional sanity: both are non-negative numbers
    expect(baselineLatency).toBeGreaterThanOrEqual(0)
    expect(cachedLatency).toBeGreaterThanOrEqual(0)
  })
})
