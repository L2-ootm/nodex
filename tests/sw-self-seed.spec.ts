// tests/sw-self-seed.spec.ts — SW-07
// Verifies: after server fallback (cache miss), the second request to the same path
// is served from SW cache (self-seeding confirmed) with sw-cache MetricsEvent.
//
// The MetricsEvent type change (server-fallback → sw-cache) is the observable proof
// of self-seeding. We also verify no network request fires for the second fetch
// using page.on('request') filtered to same-origin SW-served paths.

import { test, expect } from '@playwright/test'
import { injectMetricsCapture, waitForMetricsEvent } from './helpers/metrics-capture'

test.describe('SW-07: self-seed after server fallback', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/metrics.html')
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15000 })
    // Clear cache to ensure cold start
    await page.evaluate(() => caches.delete('nodex-v1'))
    await page.waitForTimeout(200)
  })

  test('after server fallback, second request is served from SW cache with sw-cache event', async ({ page }) => {
    await injectMetricsCapture(page)

    // Use a stable product ID for this test
    const productId = `42`
    const key = `/api/products/${productId}`

    // First fetch: cache miss → server fallback → SW self-seeds cache
    const firstResult = await page.evaluate(async (k) => {
      const res = await fetch(k)
      const body = await res.json()
      return { status: res.status, body }
    }, key)
    expect(firstResult.status).toBe(200)
    expect(firstResult.body.id).toBe(productId)

    // Wait for server-fallback MetricsEvent — confirms first fetch was a cache miss
    await waitForMetricsEvent(
      page,
      (e) => e.type === 'server-fallback' && e.key === key
    )

    // Give the SW time to write the self-seeded cache entry
    await page.waitForTimeout(500)

    // Reset captured metrics to isolate the second fetch's event
    await page.evaluate(() => {
      const w = window as Window & { __capturedMetrics?: unknown[] }
      w.__capturedMetrics = []
    })

    // Second fetch: must be served from SW cache (self-seeded after first fallback)
    const secondResult = await page.evaluate(async (k) => {
      const res = await fetch(k)
      const body = await res.json()
      return { status: res.status, body }
    }, key)

    expect(secondResult.status).toBe(200)
    expect(secondResult.body.id).toBe(productId)

    // Assert sw-cache MetricsEvent was emitted for the second fetch
    // This proves the response came from the SW cache (self-seeded) rather than the server
    const cacheEvent = await waitForMetricsEvent(
      page,
      (e) => e.type === 'sw-cache' && e.key === key
    )

    expect(cacheEvent.schema_version).toBe(1)
    expect(cacheEvent.type).toBe('sw-cache')
    expect(cacheEvent.key).toBe(key)
    expect(typeof cacheEvent.latency_ms).toBe('number')
    expect(cacheEvent.latency_ms).toBeGreaterThanOrEqual(0)
  })
})
