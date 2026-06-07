// tests/sw-lifecycle.spec.ts — SW-04
// Verifies: skipWaiting + clients.claim works (SW controller is non-null after registration),
// and that the seq Map is re-seeded from IDB on re-activation (cache survives page reload).

import { test, expect } from '@playwright/test'

test.describe('SW-04: lifecycle — skipWaiting + clients.claim', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/metrics.html')
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15000 })
  })

  test('SW controller is non-null after registration (clients.claim is effective)', async ({ page }) => {
    // The SW uses skipWaiting + clients.claim to immediately take control.
    // By the time waitForFunction resolves, the SW is already the controller.
    const hasController = await page.evaluate(() => navigator.serviceWorker.controller !== null)
    expect(hasController).toBe(true)
  })

  test('re-registering SW does not lose control — controller remains non-null', async ({ page }) => {
    // Trigger a SW re-registration (browser will check for updates)
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    })

    // After re-registration, the controller should still be non-null (skipWaiting ensured
    // the new SW (if any) immediately claimed clients)
    const hasController = await page.evaluate(() => navigator.serviceWorker.controller !== null)
    expect(hasController).toBe(true)
  })

  test('SW re-seeds seq Map from IDB on page reload — cached entry served from cache after reload', async ({ page }) => {
    // Clear cache first for isolation
    await page.evaluate(() => caches.delete('nodex-v1'))
    await page.waitForTimeout(200)

    // First fetch: seeds the cache and IDB metadata (including seq)
    await page.evaluate(() => fetch('/api/products/200'))
    await page.waitForTimeout(500)

    // Reload the page — the SW activates again and seeds its in-memory seq Map from IDB
    await page.reload()
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15000 })

    // Track network requests after reload to assert the second fetch is a cache hit
    let networkHitAfterReload = false
    page.on('request', (req) => {
      if (req.url().includes(':3001/api/products/200')) {
        networkHitAfterReload = true
      }
    })

    // Second fetch — must be served from cache (SW re-seeded seq Map from IDB)
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/products/200')
      const body = await res.json()
      return { status: res.status, body }
    })

    await page.waitForTimeout(300)

    expect(result.status).toBe(200)
    expect(result.body.id).toBe('200')
    expect(networkHitAfterReload).toBe(false)
  })
})
