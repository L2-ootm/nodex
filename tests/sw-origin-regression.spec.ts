import { expect, test } from '@playwright/test'
import { getCapturedMetrics, injectMetricsCapture, waitForMetricsEvent } from './helpers/metrics-capture'

test.describe('SW monotonic origin fallback', () => {
  test('rejects a lagging origin after one no-store retry', async ({ page }) => {
    const productId = `origin-regression-${Date.now()}`
    const key = `/api/products/${productId}`
    const invalidatePath = `api/products/${productId}`

    await page.goto('/metrics.html')
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15_000 })
    await page.evaluate(() => caches.delete('nodex-v1'))
    await injectMetricsCapture(page)

    // Establish version 1, advance the origin to version 3, then make the
    // Service Worker observe version 3 from the authoritative path.
    await page.evaluate((path) => fetch(path), key)
    await page.evaluate(async (path) => {
      await fetch(`http://localhost:3001/api/invalidate/${path}`, { method: 'POST' })
      await fetch(`http://localhost:3001/api/invalidate/${path}`, { method: 'POST' })
    }, invalidatePath)
    await page.evaluate(() => caches.delete('nodex-v1'))
    await page.evaluate((path) => fetch(path), key)
    await waitForMetricsEvent(page, (event) => event.type === 'server-fallback' && event.key === key)

    await page.evaluate(() => caches.delete('nodex-v1'))
    await page.evaluate(() => {
      const target = window as Window & { __capturedMetrics?: unknown[] }
      target.__capturedMetrics = []
    })

    // The local mock encrypts a version-2 body while its real counter remains 3.
    // Both the normal attempt and the single no-store retry must be rejected.
    const result = await page.evaluate(async (path) => {
      const response = await fetch(`${path}?__nodex_test_seq=2`)
      return {
        status: response.status,
        body: await response.text(),
        minimumVersion: response.headers.get('X-Nodex-Min-Version'),
      }
    }, key)

    expect(result.status).toBe(503)
    expect(result.body).toContain('Fresh authoritative version unavailable')
    expect(result.minimumVersion).toBe('3')

    await expect.poll(async () => {
      const events = await getCapturedMetrics(page)
      return events.filter((event) =>
        event.type === 'admission-rejected' &&
        event.key === key &&
        event.rejection_source === 'server' &&
        event.rejection_reason === 'below-session-observed'
      ).length
    }).toBe(2)
  })
})
