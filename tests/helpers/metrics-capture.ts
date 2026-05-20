// tests/helpers/metrics-capture.ts
// Shared helper for injecting a BroadcastChannel('nodex-metrics') listener
// into a Playwright page, capturing MetricsEvents into window.__capturedMetrics.

import type { Page } from '@playwright/test'
import type { MetricsEvent } from '../../src/shared/types'

/**
 * Inject a BroadcastChannel listener into the page that accumulates all
 * incoming MetricsEvents into window.__capturedMetrics[].
 *
 * Also triggers FLUSH_BUFFER on the SW controller (if present) so any
 * IDB-buffered events from before this page opened are delivered.
 *
 * Must be called BEFORE any fetch that will generate metrics you want to
 * capture (BroadcastChannel messages are not retroactive).
 */
export async function injectMetricsCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as Window & { __capturedMetrics?: unknown[] }
    if (!w.__capturedMetrics) {
      w.__capturedMetrics = []
    }

    // Attach listener if not already attached (idempotent within a page)
    if (!(w as Window & { __metricsChannelAttached?: boolean }).__metricsChannelAttached) {
      const channel = new BroadcastChannel('nodex-metrics')
      channel.addEventListener('message', (event: MessageEvent) => {
        ;(w.__capturedMetrics as unknown[]).push(event.data)
      })
      ;(w as Window & { __metricsChannelAttached?: boolean }).__metricsChannelAttached = true
    }

    // Flush any IDB-buffered events from the SW
    const controller = navigator.serviceWorker.controller
    if (controller) {
      controller.postMessage({ type: 'FLUSH_BUFFER' })
    }
  })
}

/**
 * Read all MetricsEvents captured since injectMetricsCapture() was called.
 */
export async function getCapturedMetrics(page: Page): Promise<MetricsEvent[]> {
  return page.evaluate(() => {
    const w = window as Window & { __capturedMetrics?: unknown[] }
    return (w.__capturedMetrics ?? []) as MetricsEvent[]
  }) as Promise<MetricsEvent[]>
}

/**
 * Poll getCapturedMetrics every 200ms until predicate returns true or timeout
 * elapses. Returns the first matching event. Throws on timeout.
 */
export async function waitForMetricsEvent(
  page: Page,
  predicate: (e: MetricsEvent) => boolean,
  timeout = 8000
): Promise<MetricsEvent> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const events = await getCapturedMetrics(page)
    const match = events.find(predicate)
    if (match) return match
    // Wait 200ms before next poll
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const events = await getCapturedMetrics(page)
  throw new Error(
    `waitForMetricsEvent: timed out after ${timeout}ms. Captured events: ${JSON.stringify(events)}`
  )
}
