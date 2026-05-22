// src/dashboard/dashboard.test.ts — Unit tests for pure dashboard logic functions
// Tests run in vitest (Node.js) — no DOM, no BroadcastChannel
import { describe, it, expect } from 'vitest'
import { calculateHitRate, formatLatency, prepareRowData, LatencyAccumulator } from './dashboard.js'
import type { MetricsEvent } from '../shared/types.js'

describe('calculateHitRate', () => {
  it('returns 80 when swCacheCount=8 and serverFallbackCount=2', () => {
    expect(calculateHitRate(8, 2)).toBe(80.0)
  })

  it('returns 0 when both counts are 0 (no division by zero)', () => {
    expect(calculateHitRate(0, 0)).toBe(0)
  })
})

describe('formatLatency', () => {
  it('formats 199.5 as "199.5ms"', () => {
    expect(formatLatency(199.5)).toBe('199.5ms')
  })

  it('formats 200 as "200ms" (exactly at threshold)', () => {
    expect(formatLatency(200)).toBe('200ms')
  })
})

describe('prepareRowData', () => {
  it('returns correct display fields from a MetricsEvent', () => {
    const event: MetricsEvent = {
      schema_version: 1,
      type: 'sw-cache',
      key: '/api/products/42',
      latency_ms: 12.5,
      source_node_id: 'abcdefgh-1234-5678-9abc-def012345678',
      timestamp: new Date('2026-05-19T14:30:45.123Z').getTime(),
    }

    const row = prepareRowData(event)

    expect(row.type).toBe('sw-cache')
    expect(row.key).toBe('/api/products/42')
    expect(row.latency).toBe('12.5ms')
    expect(row.sourceNodeId).toBe('abcdefgh')
    expect(typeof row.timestamp).toBe('string')
    expect(row.timestamp.length).toBeGreaterThan(0)
  })
})

describe('LatencyAccumulator', () => {
  it('getStats returns zeros for an unknown type', () => {
    const acc = new LatencyAccumulator()
    const stats = acc.getStats('sw-cache')
    expect(stats).toEqual({ p50: 0, p95: 0, p99: 0, count: 0 })
  })

  it('record and getStats: single sample — p50/p95/p99 all equal the sample', () => {
    const acc = new LatencyAccumulator()
    acc.record('sw-cache', 50)
    const stats = acc.getStats('sw-cache')
    expect(stats.count).toBe(1)
    expect(stats.p50).toBe(50)
    expect(stats.p95).toBe(50)
    expect(stats.p99).toBe(50)
  })

  it('p50 is the median of sorted samples', () => {
    const acc = new LatencyAccumulator()
    for (const v of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      acc.record('server-fallback', v)
    }
    const stats = acc.getStats('server-fallback')
    expect(stats.count).toBe(10)
    // ceil(50/100 * 10) - 1 = 5 - 1 = 4 → sorted[4] = 50
    expect(stats.p50).toBe(50)
  })

  it('p95 rounds to the 95th percentile index', () => {
    const acc = new LatencyAccumulator()
    for (const v of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      acc.record('peer-fetch', v)
    }
    const stats = acc.getStats('peer-fetch')
    // ceil(95/100 * 10) - 1 = 10 - 1 = 9 → sorted[9] = 100
    expect(stats.p95).toBe(100)
  })

  it('accumulates across multiple calls and keeps separate bins per type', () => {
    const acc = new LatencyAccumulator()
    acc.record('sw-cache', 10)
    acc.record('sw-cache', 20)
    acc.record('server-fallback', 200)
    expect(acc.getStats('sw-cache').count).toBe(2)
    expect(acc.getStats('server-fallback').count).toBe(1)
    expect(acc.getStats('peer-fetch').count).toBe(0)
  })
})
