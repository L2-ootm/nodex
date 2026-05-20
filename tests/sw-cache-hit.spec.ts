// tests/sw-cache-hit.spec.ts — SW-02
// Verifies: second GET /api/products/1 is served from SW cache with zero outbound network request.

import { test, expect } from '@playwright/test'

test.describe('SW-02: cache hit', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15000 })
    // Clear cache state for isolation
    await page.evaluate(() => caches.delete('nodex-v1'))
  })

  test('second GET /api/products/1 served from SW cache with no network request', async ({ page }) => {
    // First fetch: cache miss → SW falls back to server, seeds cache
    const firstResult = await page.evaluate(async () => {
      const res = await fetch('/api/products/1')
      const body = await res.json()
      return { status: res.status, body }
    })
    expect(firstResult.status).toBe(200)
    expect(firstResult.body.id).toBe('1')

    // Give the SW time to fully write the cache entry before the second fetch
    await page.waitForTimeout(300)

    // Track whether a NEW request fires to port 3001 during the second fetch
    let networkHitDuringSecondFetch = false
    page.on('request', (req) => {
      if (req.url().includes(':3001/api/products/1')) {
        networkHitDuringSecondFetch = true
      }
    })

    // Second fetch: must be served from SW cache
    const secondResult = await page.evaluate(async () => {
      const res = await fetch('/api/products/1')
      const body = await res.json()
      return { status: res.status, body }
    })

    // Allow any async request to flush
    await page.waitForTimeout(300)

    expect(secondResult.status).toBe(200)
    expect(secondResult.body.id).toBe('1')
    expect(networkHitDuringSecondFetch).toBe(false)
  })

  test('cache hit response body is valid JSON with correct product data', async ({ page }) => {
    // Seed the cache
    await page.evaluate(() => fetch('/api/products/2'))
    await page.waitForTimeout(500)

    // Second fetch — from cache
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/products/2')
      return res.json()
    })

    expect(result).toMatchObject({ id: '2', name: 'Product 2', price: 9.99 })
  })
})
