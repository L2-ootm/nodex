// src/dashboard/dashboard.test.ts — Unit tests for pure dashboard logic functions
// Tests run in vitest (Node.js) — no DOM, no BroadcastChannel
import { describe, it, expect } from 'vitest'
import { calculateHitRate, formatLatency, prepareRowData } from './dashboard.js'
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
    // source_node_id truncated to 8 chars
    expect(row.sourceNodeId).toBe('abcdefgh')
    // timestamp formatted as a string (non-empty)
    expect(typeof row.timestamp).toBe('string')
    expect(row.timestamp.length).toBeGreaterThan(0)
  })
})
