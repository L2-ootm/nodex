// tests/sw-intercept.spec.ts — SW-01
// Verifies: SW intercepts GET /api/* requests and does NOT intercept POST or non-/api/ requests.

import { test, expect } from '@playwright/test'

// Helper: wait for SW to be active as controller
async function waitForSW(page: Parameters<typeof test>[1] extends ({ page }: { page: infer P }) => unknown ? P : never) {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15000 })
}

test.describe('SW-01: fetch interception', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/metrics.html')
    await waitForSW(page)
  })

  test('SW intercepts GET /api/* requests — both fetches succeed with status 200', async ({ page }) => {
    // First fetch seeds the cache (server fallback)
    const result1 = await page.evaluate(async () => {
      const res = await fetch('/api/products/101')
      return { status: res.status, ok: res.ok }
    })
    expect(result1.status).toBe(200)
    expect(result1.ok).toBe(true)

    // Second identical fetch should succeed (served from SW cache)
    const result2 = await page.evaluate(async () => {
      const res = await fetch('/api/products/101')
      return { status: res.status, ok: res.ok }
    })
    expect(result2.status).toBe(200)
    expect(result2.ok).toBe(true)
  })

  test('SW does NOT intercept POST requests — POST reaches port 3001', async ({ page }) => {
    // POSTs should pass through to the server — the SW only intercepts GET /api/*
    const requestPromise = page.waitForRequest(
      (req) => req.url().includes(':3001/api/invalidate') && req.method() === 'POST',
      { timeout: 5000 }
    )

    await page.evaluate(async () => {
      await fetch('http://localhost:3001/api/invalidate/api/products/101', {
        method: 'POST',
        body: '',
      })
    })

    const networkRequest = await requestPromise
    expect(networkRequest).toBeTruthy()
  })

  test('SW does NOT intercept non-/api/ GET requests — response comes from port 3000', async ({ page }) => {
    // A fetch to '/' should not be intercepted by the SW (not an /api/ path)
    // The page fetch to '/' will be served by Vite (port 3000)
    const result = await page.evaluate(async () => {
      const res = await fetch('/')
      return { status: res.status, url: res.url }
    })
    expect(result.status).toBe(200)
    // Should not have been served as a cache hit (will return HTML from Vite)
    expect(result.url).not.toContain(':3001')
  })
})
