// tests/metrics-emit.spec.ts — METR-01, METR-02
// Verifies: every cache decision emits a MetricsEvent with complete schema_version: 1 fields,
// and that hit-rate counts (sw-cache vs total) are accurate.

import { test, expect } from '@playwright/test'
import { injectMetricsCapture, getCapturedMetrics, waitForMetricsEvent } from './helpers/metrics-capture'

test.describe('METR-01 + METR-02: MetricsEvent schema and hit rate', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15000 })
    await page.evaluate(() => caches.delete('nodex-v1'))
    await page.waitForTimeout(200)
    await injectMetricsCapture(page)
    // Clear any buffered metrics that were flushed on inject
    await page.waitForTimeout(300)
    await page.evaluate(() => {
      const w = window as Window & { __capturedMetrics?: unknown[] }
      w.__capturedMetrics = []
    })
  })

  test('server-fallback event has complete schema_version: 1 schema', async ({ page }) => {
    // First fetch to a new product ID — triggers server-fallback
    await page.evaluate(() => fetch('/api/products/5'))

    const fallbackEvent = await waitForMetricsEvent(
      page,
      (e) => e.key === '/api/products/5' && e.type === 'server-fallback'
    )

    // METR-01: all required fields present and correctly typed
    expect(fallbackEvent.schema_version).toBe(1)
    expect(typeof fallbackEvent.type).toBe('string')
    expect(['sw-cache', 'peer-fetch', 'server-fallback']).toContain(fallbackEvent.type)
    expect(typeof fallbackEvent.key).toBe('string')
    expect(fallbackEvent.key).toBe('/api/products/5')
    expect(typeof fallbackEvent.latency_ms).toBe('number')
    expect(fallbackEvent.latency_ms).toBeGreaterThanOrEqual(0)
    expect(typeof fallbackEvent.source_node_id).toBe('string')
    expect(fallbackEvent.source_node_id.length).toBeGreaterThan(0)
    expect(typeof fallbackEvent.timestamp).toBe('number')
    expect(fallbackEvent.timestamp).toBeGreaterThan(0)
  })

  test('sw-cache event has complete schema_version: 1 schema', async ({ page }) => {
    // First fetch seeds the cache
    await page.evaluate(() => fetch('/api/products/5'))
    await waitForMetricsEvent(page, (e) => e.key === '/api/products/5' && e.type === 'server-fallback')

    // Give SW time to write cache entry
    await page.waitForTimeout(300)

    // Reset metrics
    await page.evaluate(() => {
      const w = window as Window & { __capturedMetrics?: unknown[] }
      w.__capturedMetrics = []
    })

    // Second fetch — served from cache
    await page.evaluate(() => fetch('/api/products/5'))

    const cacheEvent = await waitForMetricsEvent(
      page,
      (e) => e.key === '/api/products/5' && e.type === 'sw-cache'
    )

    // METR-01: all required fields
    expect(cacheEvent.schema_version).toBe(1)
    expect(cacheEvent.type).toBe('sw-cache')
    expect(typeof cacheEvent.key).toBe('string')
    expect(cacheEvent.key).toBe('/api/products/5')
    expect(typeof cacheEvent.latency_ms).toBe('number')
    expect(cacheEvent.latency_ms).toBeGreaterThanOrEqual(0)
    expect(typeof cacheEvent.source_node_id).toBe('string')
    expect(cacheEvent.source_node_id.length).toBeGreaterThan(0)
    expect(typeof cacheEvent.timestamp).toBe('number')
    expect(cacheEvent.timestamp).toBeGreaterThan(0)
  })

  test('METR-02: hit rate counts — 4 of 5 fetches produce sw-cache events', async ({ page }) => {
    // First fetch seeds the cache (1 server-fallback)
    await page.evaluate(() => fetch('/api/products/5'))
    await waitForMetricsEvent(page, (e) => e.key === '/api/products/5' && e.type === 'server-fallback')
    await page.waitForTimeout(300)

    // Reset metrics
    await page.evaluate(() => {
      const w = window as Window & { __capturedMetrics?: unknown[] }
      w.__capturedMetrics = []
    })

    // Fetch the same product 4 more times — all should be cache hits
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => fetch('/api/products/5'))
      await page.waitForTimeout(100)
    }

    // Wait for 4 sw-cache events
    await page.waitForFunction(
      () => {
        const w = window as Window & { __capturedMetrics?: Array<{ type: string; key: string }> }
        const events = w.__capturedMetrics ?? []
        return events.filter((e) => e.type === 'sw-cache' && e.key === '/api/products/5').length >= 4
      },
      { timeout: 8000 }
    )

    const events = await getCapturedMetrics(page)
    const cacheHits = events.filter((e) => e.type === 'sw-cache' && e.key === '/api/products/5')
    const total = events.filter((e) => e.key === '/api/products/5')

    // METR-02: hit rate = cacheHits / total — should be 4/4 = 100% in this window
    expect(cacheHits.length).toBeGreaterThanOrEqual(4)
    expect(total.length).toBeGreaterThanOrEqual(4)

    const hitRate = cacheHits.length / total.length
    expect(hitRate).toBeGreaterThanOrEqual(0.9) // >= 90% hit rate after seeding
  })
})
