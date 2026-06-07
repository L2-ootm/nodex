// tests/sw-fallback.spec.ts — SW-06
// Verifies: cache miss triggers server fallback and emits server-fallback MetricsEvent
// with all required schema fields.
//
// Note: SW-initiated fetches are not reliably captured by page.on('request') in Playwright.
// We use MetricsEvent type 'server-fallback' as the observable proof that the SW went to network.

import { test, expect } from '@playwright/test'
import { injectMetricsCapture, waitForMetricsEvent } from './helpers/metrics-capture'

test.describe('SW-06: server fallback on cache miss', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/metrics.html')
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15000 })
    // Clear cache to ensure a cold miss
    await page.evaluate(() => caches.delete('nodex-v1'))
    await page.waitForTimeout(200)
  })

  test('cache miss triggers server fallback with server-fallback metric', async ({ page }) => {
    await injectMetricsCapture(page)

    // Use a unique product ID to avoid cache contamination from other tests
    const productId = `sw06-${Date.now()}`
    const key = `/api/products/${productId}`

    // Fetch a product not in cache → triggers SW server fallback
    const result = await page.evaluate(async (k) => {
      const res = await fetch(k)
      const body = await res.json()
      return { status: res.status, body }
    }, key)

    expect(result.status).toBe(200)
    expect(result.body.id).toBe(productId)

    // Assert server-fallback MetricsEvent was emitted with correct schema
    // This proves the SW went to the server (cache miss → server-fallback path)
    const fallbackEvent = await waitForMetricsEvent(
      page,
      (e) => e.type === 'server-fallback' && e.key === key
    )

    expect(fallbackEvent.schema_version).toBe(1)
    expect(fallbackEvent.type).toBe('server-fallback')
    expect(fallbackEvent.key).toBe(key)
    expect(typeof fallbackEvent.latency_ms).toBe('number')
    expect(fallbackEvent.latency_ms).toBeGreaterThanOrEqual(0)
    expect(typeof fallbackEvent.source_node_id).toBe('string')
    expect(fallbackEvent.source_node_id.length).toBeGreaterThan(0)
    expect(typeof fallbackEvent.timestamp).toBe('number')
  })
})
