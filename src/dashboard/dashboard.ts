// src/dashboard/dashboard.ts — Full metrics dashboard
// BroadcastChannel listener, hit rate counter, event log table,
// fetch/invalidate form handlers, SW status detection, FLUSH_BUFFER trigger.
// Phase 3 additions: LatencyAccumulator, Gossip Propagation panel, Latency Percentiles panel.
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
  return `${String(latency_ms)}ms`
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
// LatencyAccumulator — pure class for p50/p95/p99 latency stats (METR-04)
// Exported for vitest unit testing and Playwright window.__latencyAccumulator
// ---------------------------------------------------------------------------

export class LatencyAccumulator {
  private samples = new Map<string, number[]>()

  record(type: string, latency_ms: number): void {
    const arr = this.samples.get(type)
    if (arr) {
      arr.push(latency_ms)
    } else {
      this.samples.set(type, [latency_ms])
    }
  }

  getStats(type: string): { p50: number; p95: number; p99: number; count: number } {
    const arr = this.samples.get(type)
    if (!arr || arr.length === 0) {
      return { p50: 0, p95: 0, p99: 0, count: 0 }
    }
    const sorted = [...arr].sort((a, b) => a - b)
    return {
      p50: this.percentile(sorted, 50),
      p95: this.percentile(sorted, 95),
      p99: this.percentile(sorted, 99),
      count: sorted.length,
    }
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0
    const idx = Math.ceil((p / 100) * sorted.length) - 1
    return Math.round(sorted[Math.max(0, idx)])
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

  // LatencyAccumulator instance — exposed on window for Playwright METR-04 test
  const accumulator = new LatencyAccumulator()
  if (typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>)['__latencyAccumulator'] = accumulator
  }

  // Volatility score cache — exposed on window for Playwright VOL tests (VOL-02, VOL-04, VOL-05)
  const volatilityScores = new Map<string, { score: number; tier: string }>()
  if (typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>)['__volatilityScores'] = volatilityScores
  }

  // ---------------------------------------------------------------------------
  // SW Registration + Status
  // ---------------------------------------------------------------------------

  const liveDot = document.getElementById('live-dot') as HTMLSpanElement | null
  const swStatusChip = document.getElementById('sw-status-chip') as HTMLSpanElement | null
  const swBanner = document.getElementById('sw-banner') as HTMLDivElement | null

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      console.error('[dashboard] SW registration failed:', err)
    })

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
        // If controller raced ahead of ready, wait for controllerchange before init
        if (!navigator.serviceWorker.controller) {
          await new Promise<void>((resolve) => {
            navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })
          })
        }
        await peerManager.init()
        // Fetch session key and post to SW for AES-GCM decryption (CRPT-02, idempotent)
        fetch('/api/session-key')
          .then((r) => r.json())
          .then((data) => {
            const { keyId, keyBytes } = data as { keyId: string; keyBytes: string }
            if (navigator.serviceWorker.controller) {
              navigator.serviceWorker.controller.postMessage({ type: 'IMPORT_SESSION_KEY', keyId, keyBytes })
            }
          })
          .catch((err) => console.warn('[dashboard] session key fetch failed:', err))
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
  channel.onmessage = (event: MessageEvent<unknown>) => {
    // Type guard: volatility-update events are not MetricsEvents — handle separately
    const data = event.data as Record<string, unknown>
    if (data?.type === 'volatility-update') {
      const key = data['key'] as string
      const score = data['score'] as number
      const tier = data['tier'] as string
      if (typeof key === 'string' && typeof score === 'number' && typeof tier === 'string') {
        updateVolatilityDisplay(key, score, tier)
      }
      return
    }
    handleMetricsEvent(event.data as MetricsEvent)
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'FLUSH_BUFFER' })
    }
  })

  // ---------------------------------------------------------------------------
  // Metrics event handler DOM elements
  // ---------------------------------------------------------------------------

  const hitRateDisplay = document.getElementById('hit-rate-display') as HTMLSpanElement | null
  const fallbackDisplay = document.getElementById('fallback-display') as HTMLSpanElement | null
  const eventTbody = document.getElementById('event-tbody') as HTMLTableSectionElement | null
  const emptyState = document.getElementById('empty-state') as HTMLDivElement | null

  // Gossip propagation panel elements (METR-03)
  const gossipTable = document.getElementById('gossip-table') as HTMLTableElement | null
  const gossipTbody = document.getElementById('gossip-tbody') as HTMLTableSectionElement | null
  const gossipEmptyState = document.getElementById('gossip-empty-state') as HTMLDivElement | null

  // Latency percentile panel elements (METR-04)
  const latencyStatsTable = document.getElementById('latency-stats-table') as HTMLTableElement | null
  const latencyTbody = document.getElementById('latency-tbody') as HTMLTableSectionElement | null
  const latencyEmptyState = document.getElementById('latency-empty-state') as HTMLDivElement | null

  // Volatility tier panel elements (VOL-04)
  const volatilityPanel = document.getElementById('volatility-panel') as HTMLElement | null
  const volatilityTbody = document.getElementById('volatility-tbody') as HTMLTableSectionElement | null
  const volatilityEmptyState = document.getElementById('volatility-empty-state') as HTMLDivElement | null
  const volatilityTable = document.getElementById('volatility-table') as HTMLTableElement | null

  // ---------------------------------------------------------------------------
  // renderGossipRow — prepend a gossip-propagation event to gossip-tbody (max 10 rows)
  // ---------------------------------------------------------------------------

  function renderGossipRow(event: MetricsEvent): void {
    if (!gossipTbody) return

    const propagation_ms = (event.t_received ?? Date.now()) - (event.t_invalidate ?? Date.now())
    const hop_count = event.hop_count ?? 0
    const msgIdShort = (event.msgId ?? '').slice(0, 8).toUpperCase()

    const now = new Date(event.t_received ?? Date.now())
    const hh = String(now.getHours()).padStart(2, '0')
    const mm = String(now.getMinutes()).padStart(2, '0')
    const ss = String(now.getSeconds()).padStart(2, '0')
    const ms = String(now.getMilliseconds()).padStart(3, '0')
    const receivedAt = `${hh}:${mm}:${ss}.${ms}`

    const tr = document.createElement('tr')

    const tdMsg = document.createElement('td')
    tdMsg.className = 'mono'
    tdMsg.textContent = msgIdShort  // textContent (T-03-01)

    const tdKey = document.createElement('td')
    tdKey.className = 'mono'
    tdKey.textContent = event.key  // textContent (T-03-01)

    const tdProp = document.createElement('td')
    tdProp.className = 'col-right'
    const propClass = propagation_ms < 100 ? 'propagation--normal' : propagation_ms < 250 ? 'propagation--warn' : 'propagation--slow'
    tdProp.classList.add(propClass)
    tdProp.textContent = `${Math.round(propagation_ms)}ms`

    const tdHop = document.createElement('td')
    tdHop.className = 'col-right'
    tdHop.textContent = String(hop_count)

    const tdTs = document.createElement('td')
    tdTs.className = 'col-right mono'
    tdTs.textContent = receivedAt

    tr.appendChild(tdMsg)
    tr.appendChild(tdKey)
    tr.appendChild(tdProp)
    tr.appendChild(tdHop)
    tr.appendChild(tdTs)

    gossipTbody.insertBefore(tr, gossipTbody.firstChild)

    // Cap at 10 rows (T-03-02 — bounded panel)
    while (gossipTbody.children.length > 10) {
      gossipTbody.removeChild(gossipTbody.lastChild as Node)
    }

    // Unhide table, hide empty state
    if (gossipTable) gossipTable.hidden = false
    if (gossipEmptyState) gossipEmptyState.hidden = true
  }

  // ---------------------------------------------------------------------------
  // updateLatencyStats — recompute and render p50/p95/p99 rows in latency-tbody
  // ---------------------------------------------------------------------------

  function updateLatencyStats(): void {
    if (!latencyTbody) return

    const types = ['sw-cache', 'peer-fetch', 'server-fallback'] as const
    let firstUpdate = latencyTbody.children.length === 0

    for (const type of types) {
      const stats = accumulator.getStats(type)
      let row = latencyTbody.querySelector(`tr[data-source-type="${type}"]`) as HTMLTableRowElement | null

      if (!row) {
        row = document.createElement('tr')
        row.setAttribute('data-source-type', type)

        const tdType = document.createElement('td')
        const badge = document.createElement('span')
        badge.className = `badge badge--${type}`
        badge.textContent = type  // textContent (T-03-01)
        tdType.appendChild(badge)

        const tdP50 = document.createElement('td')
        tdP50.className = 'col-right mono'
        const tdP95 = document.createElement('td')
        tdP95.className = 'col-right mono'
        const tdP99 = document.createElement('td')
        tdP99.className = 'col-right mono'
        const tdCount = document.createElement('td')
        tdCount.className = 'col-right mono'

        row.appendChild(tdType)
        row.appendChild(tdP50)
        row.appendChild(tdP95)
        row.appendChild(tdP99)
        row.appendChild(tdCount)
        latencyTbody.appendChild(row)
        firstUpdate = true
      }

      const cells = row.querySelectorAll('td')
      if (cells[1]) cells[1].textContent = `${stats.p50}ms`
      if (cells[2]) cells[2].textContent = `${stats.p95}ms`
      if (cells[3]) cells[3].textContent = `${stats.p99}ms`
      if (cells[4]) cells[4].textContent = String(stats.count)
    }

    if (firstUpdate) {
      if (latencyStatsTable) latencyStatsTable.hidden = false
      if (latencyEmptyState) latencyEmptyState.hidden = true
    }
  }

  // ---------------------------------------------------------------------------
  // updateVolatilityDisplay — upsert a row in the volatility-panel table (VOL-04)
  // ---------------------------------------------------------------------------

  function updateVolatilityDisplay(key: string, score: number, tier: string): void {
    // Update in-memory map (exposed as window.__volatilityScores for Playwright)
    volatilityScores.set(key, { score, tier })

    if (!volatilityTbody) return

    // Find existing row for this key, or create a new one.
    // Use raw attribute value matching — CSS.escape() transforms / and : which are valid
    // in data-attribute values but would break the selector match (WR-01).
    const escapedKey = key.replace(/"/g, '\\"')
    let row = volatilityTbody.querySelector(`tr[data-vol-key="${escapedKey}"]`) as HTMLTableRowElement | null

    if (!row) {
      row = document.createElement('tr')
      row.setAttribute('data-vol-key', key)

      const tdKey = document.createElement('td')
      tdKey.className = 'mono'
      tdKey.textContent = key  // textContent (T-03-01: no innerHTML)

      const tdTier = document.createElement('td')
      tdTier.className = `vol-tier vol-tier--${tier}`

      const tdScore = document.createElement('td')
      tdScore.className = 'col-right mono'

      row.appendChild(tdKey)
      row.appendChild(tdTier)
      row.appendChild(tdScore)
      volatilityTbody.appendChild(row)
    }

    // Update tier and score cells (textContent only — T-03-01)
    const cells = row.querySelectorAll('td')
    if (cells[1]) {
      cells[1].textContent = tier
      cells[1].className = `vol-tier vol-tier--${tier}`
    }
    if (cells[2]) {
      cells[2].textContent = score.toFixed(3)
    }

    // Show table, hide empty state
    if (volatilityTable) volatilityTable.hidden = false
    if (volatilityEmptyState) volatilityEmptyState.hidden = true
    if (volatilityPanel) volatilityPanel.hidden = false
  }

  // ---------------------------------------------------------------------------
  // handleMetricsEvent — dispatch to gossip panel, latency accumulator, event log
  // ---------------------------------------------------------------------------

  function handleMetricsEvent(event: MetricsEvent): void {
    // Gossip-propagation events go to the gossip panel only (not the main event log)
    if (event.type === 'gossip-propagation') {
      renderGossipRow(event)
      return
    }

    // Update counters (peer-fetch counts as a cache hit for rate display)
    if (event.type === 'sw-cache' || event.type === 'peer-fetch') {
      swCacheCount++
    } else if (event.type === 'server-fallback') {
      serverFallbackCount++
    }

    // Accumulate latency samples for percentile stats (METR-04)
    if (event.type === 'sw-cache' || event.type === 'peer-fetch' || event.type === 'server-fallback') {
      accumulator.record(event.type, event.latency_ms)
      updateLatencyStats()
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

      const tdType = document.createElement('td')
      const badge = document.createElement('span')
      badge.className = `badge badge--${event.type}`
      badge.textContent = event.type  // textContent (T-03-01)
      tdType.appendChild(badge)

      const tdKey = document.createElement('td')
      tdKey.className = 'mono'
      tdKey.textContent = row.key  // textContent (T-03-01)

      const tdLatency = document.createElement('td')
      tdLatency.className = 'col-right'
      if (event.latency_ms >= 200) {
        tdLatency.classList.add('latency--warn')
        tdLatency.title = `${event.latency_ms}ms — above 200ms threshold`
      }
      tdLatency.textContent = row.latency

      const tdNode = document.createElement('td')
      tdNode.className = 'mono'
      tdNode.textContent = row.sourceNodeId

      const tdTs = document.createElement('td')
      tdTs.className = 'col-secondary'
      tdTs.textContent = row.timestamp

      tr.appendChild(tdType)
      tr.appendChild(tdKey)
      tr.appendChild(tdLatency)
      tr.appendChild(tdNode)
      tr.appendChild(tdTs)

      eventTbody.insertBefore(tr, eventTbody.firstChild)

      // Cap at 50 rows (T-03-04)
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
          return res.text()
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
