// src/dashboard/dashboard.ts — Full metrics dashboard
// BroadcastChannel listener, hit rate counter, event log table,
// fetch/invalidate form handlers, SW status detection, FLUSH_BUFFER trigger.
//
// STRIDE mitigations:
//   T-03-01: all event data rendered via textContent (never innerHTML)
//   T-03-04: event log capped at 50 rows (oldest removed from DOM)

import type { MetricsEvent } from '../shared/types.js'
import { METRICS_CHANNEL_NAME } from '../shared/config.js'
import { peerManager } from '../p2p/p2p-manager.js'

// ---------------------------------------------------------------------------
// Pure exported functions (no DOM, no BroadcastChannel — testable under vitest)
// ---------------------------------------------------------------------------

/**
 * Calculate cache hit rate percentage.
 * Returns 0 when total count is 0 (no division by zero).
 */
export function calculateHitRate(swCacheCount: number, serverFallbackCount: number): number {
  const total = swCacheCount + serverFallbackCount
  if (total === 0) return 0
  return (swCacheCount / total) * 100
}

/**
 * Format a latency value as a string with 'ms' suffix.
 * Strips trailing zeros from decimal representation.
 */
export function formatLatency(latency_ms: number): string {
  // Use toPrecision-style: show up to 1 decimal if needed, strip trailing .0
  const formatted = Number.isInteger(latency_ms)
    ? String(latency_ms)
    : String(latency_ms)
  return `${formatted}ms`
}

/**
 * Transform a MetricsEvent into display-ready row data.
 * source_node_id is truncated to 8 characters for column width.
 * timestamp is formatted as HH:MM:SS.mmm local time.
 */
export function prepareRowData(event: MetricsEvent): {
  type: string
  key: string
  latency: string
  sourceNodeId: string
  timestamp: string
} {
  const d = new Date(event.timestamp)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  const timestamp = `${hh}:${mm}:${ss}.${ms}`

  return {
    type: event.type,
    key: event.key,
    latency: formatLatency(event.latency_ms),
    sourceNodeId: event.source_node_id.slice(0, 8),
    timestamp,
  }
}

// ---------------------------------------------------------------------------
// DOM-dependent logic — only runs in browser context (DOMContentLoaded)
// ---------------------------------------------------------------------------

// Guard: do not execute DOM code when imported in a test environment (no document)
if (typeof document !== 'undefined') {
  // Counters
  let swCacheCount = 0
  let serverFallbackCount = 0

  // ---------------------------------------------------------------------------
  // SW Registration + Status
  // ---------------------------------------------------------------------------

  const liveDot = document.getElementById('live-dot') as HTMLSpanElement | null
  const swStatusChip = document.getElementById('sw-status-chip') as HTMLSpanElement | null
  const swBanner = document.getElementById('sw-banner') as HTMLDivElement | null

  if ('serviceWorker' in navigator) {
    // Register SW
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      console.error('[dashboard] SW registration failed:', err)
    })

    // Set a timeout: if ready hasn't resolved in 5s, show not-detected state
    const swTimeoutId = setTimeout(() => {
      if (liveDot) {
        liveDot.classList.remove('live-dot--active')
        liveDot.classList.add('live-dot--inactive')
      }
      if (swBanner) {
        swBanner.hidden = false
      }
    }, 5000)

    navigator.serviceWorker.ready
      .then(async () => {
        clearTimeout(swTimeoutId)
        if (liveDot) {
          liveDot.classList.add('live-dot--active')
        }
        if (swStatusChip) {
          swStatusChip.textContent = 'SW: active'
        }
        if (navigator.serviceWorker.controller) {
          await peerManager.init()
        }
      })
      .catch(() => {
        clearTimeout(swTimeoutId)
        if (liveDot) liveDot.classList.add('live-dot--inactive')
        if (swBanner) swBanner.hidden = false
      })
  } else {
    if (liveDot) liveDot.classList.add('live-dot--inactive')
    if (swBanner) swBanner.hidden = false
  }

  // ---------------------------------------------------------------------------
  // BroadcastChannel listener
  // ---------------------------------------------------------------------------

  const channel = new BroadcastChannel(METRICS_CHANNEL_NAME)
  channel.onmessage = (event: MessageEvent<MetricsEvent>) => {
    handleMetricsEvent(event.data)
  }

  // Send FLUSH_BUFFER on page open so the SW re-emits buffered events (D-15)
  document.addEventListener('DOMContentLoaded', () => {
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'FLUSH_BUFFER' })
    }
  })

  // ---------------------------------------------------------------------------
  // Metrics event handler
  // ---------------------------------------------------------------------------

  const hitRateDisplay = document.getElementById('hit-rate-display') as HTMLSpanElement | null
  const fallbackDisplay = document.getElementById('fallback-display') as HTMLSpanElement | null
  const eventTbody = document.getElementById('event-tbody') as HTMLTableSectionElement | null
  const emptyState = document.getElementById('empty-state') as HTMLDivElement | null

  function handleMetricsEvent(event: MetricsEvent): void {
    // Update counters
    if (event.type === 'sw-cache') {
      swCacheCount++
    } else if (event.type === 'server-fallback') {
      serverFallbackCount++
    }

    // Update hit rate displays
    const hitRate = calculateHitRate(swCacheCount, serverFallbackCount)
    const fallbackRate = calculateHitRate(serverFallbackCount, swCacheCount)

    if (hitRateDisplay) {
      hitRateDisplay.textContent = `${hitRate.toFixed(1)}%`
    }
    if (fallbackDisplay) {
      fallbackDisplay.textContent = `${fallbackRate.toFixed(1)}%`
    }

    // Hide empty state on first event
    if (emptyState && !emptyState.hidden) {
      emptyState.hidden = true
    }

    // Prepend row to event log table (T-03-01: use textContent not innerHTML)
    if (eventTbody) {
      const row = prepareRowData(event)
      const tr = document.createElement('tr')

      // Type cell — badge chip
      const tdType = document.createElement('td')
      const badge = document.createElement('span')
      badge.className = `badge badge--${event.type}`
      badge.textContent = event.type  // textContent is safe (T-03-01)
      tdType.appendChild(badge)

      // Key cell
      const tdKey = document.createElement('td')
      tdKey.className = 'mono'
      tdKey.textContent = row.key  // textContent (T-03-01)

      // Latency cell
      const tdLatency = document.createElement('td')
      tdLatency.className = 'col-right'
      if (event.latency_ms >= 200) {
        tdLatency.classList.add('latency--warn')
        tdLatency.title = `${event.latency_ms}ms — above 200ms threshold`
      }
      tdLatency.textContent = row.latency

      // Source node ID cell (truncated to 8 chars)
      const tdNode = document.createElement('td')
      tdNode.className = 'mono'
      tdNode.textContent = row.sourceNodeId

      // Timestamp cell
      const tdTs = document.createElement('td')
      tdTs.className = 'col-secondary'
      tdTs.textContent = row.timestamp

      tr.appendChild(tdType)
      tr.appendChild(tdKey)
      tr.appendChild(tdLatency)
      tr.appendChild(tdNode)
      tr.appendChild(tdTs)

      // Prepend new row at the top
      eventTbody.insertBefore(tr, eventTbody.firstChild)

      // Cap at 50 rows — remove excess from the bottom (T-03-04)
      while (eventTbody.children.length > 50) {
        eventTbody.removeChild(eventTbody.lastChild as Node)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Fetch Product form
  // ---------------------------------------------------------------------------

  const fetchForm = document.getElementById('fetch-form') as HTMLFormElement | null
  const productIdInput = document.getElementById('product-id') as HTMLInputElement | null
  const fetchBtn = document.getElementById('fetch-btn') as HTMLButtonElement | null
  const fetchError = document.getElementById('fetch-error') as HTMLSpanElement | null

  if (fetchForm) {
    fetchForm.addEventListener('submit', (e) => {
      e.preventDefault()
      const id = productIdInput?.value.trim() || '1'
      const url = `/api/products/${id}`

      if (fetchBtn) fetchBtn.disabled = true
      if (fetchError) fetchError.textContent = ''

      fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json()
        })
        .then(() => {
          // Success — event will arrive via BroadcastChannel
        })
        .catch(() => {
          if (fetchError) {
            fetchError.textContent = 'Request failed. Check that the mock API is running on port 3001.'
          }
        })
        .finally(() => {
          if (fetchBtn) fetchBtn.disabled = false
        })
    })
  }

  // ---------------------------------------------------------------------------
  // Invalidate Path form
  // ---------------------------------------------------------------------------

  const invalidateForm = document.getElementById('invalidate-form') as HTMLFormElement | null
  const invalidatePathInput = document.getElementById('invalidate-path') as HTMLInputElement | null
  const invalidateBtn = document.getElementById('invalidate-btn') as HTMLButtonElement | null
  const invalidateResult = document.getElementById('invalidate-result') as HTMLSpanElement | null

  if (invalidateForm) {
    invalidateForm.addEventListener('submit', (e) => {
      e.preventDefault()
      const path = invalidatePathInput?.value.trim() || '/api/products/1'
      const url = `http://localhost:3001/api/invalidate${path}`

      if (invalidateBtn) invalidateBtn.disabled = true
      if (invalidateResult) invalidateResult.textContent = ''

      fetch(url, { method: 'POST' })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json() as Promise<{ path: string; newSeq: number }>
        })
        .then((data) => {
          if (invalidateResult) {
            invalidateResult.textContent = `Sequence bumped to ${data.newSeq}`
            setTimeout(() => {
              if (invalidateResult) invalidateResult.textContent = ''
            }, 3000)
          }
        })
        .catch(() => {
          if (invalidateResult) {
            invalidateResult.textContent = 'Invalidation failed. Check that the mock API is running on port 3001.'
          }
        })
        .finally(() => {
          if (invalidateBtn) invalidateBtn.disabled = false
        })
    })
  }
}
