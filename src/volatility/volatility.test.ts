import { describe, it, expect } from 'vitest'
import { computeScore, classifyTier, deriveTTL } from './volatility.js'
import {
  VOL_TTL_STABLE_MS,
  VOL_TTL_VOLATILE_MS,
  VOL_P2P_GATE,
  VOL_DECAY_WINDOW_MS,
  VOL_CHANGE_BASELINE,
  VOL_ACCESS_BASELINE,
} from '../shared/config.js'

// Freeze a deterministic "now" to make timing-sensitive tests reproducible.
// All entries with last_changed_at = NOW are "just changed"; last_changed_at = FAR_PAST is fully decayed.
const NOW = 1_000_000_000_000
const FAR_PAST = NOW - VOL_DECAY_WINDOW_MS * 10  // well beyond the decay window → recency_decay = 0
const TWO_MIN_AGO = NOW - 2 * 60 * 1000           // 2 minutes before NOW

describe('classifyTier', () => {
  it('maps 0 to stable', () => {
    expect(classifyTier(0)).toBe('stable')
  })

  it('maps 0.39 to stable', () => {
    expect(classifyTier(0.39)).toBe('stable')
  })

  it('maps exactly 0.4 to volatile', () => {
    expect(classifyTier(0.4)).toBe('volatile')
  })

  it('maps 0.79 to volatile', () => {
    expect(classifyTier(0.79)).toBe('volatile')
  })

  it('maps exactly 0.8 (VOL_P2P_GATE) to ephemeral', () => {
    expect(classifyTier(VOL_P2P_GATE)).toBe('ephemeral')
  })

  it('maps 1 to ephemeral', () => {
    expect(classifyTier(1)).toBe('ephemeral')
  })
})

describe('deriveTTL', () => {
  it('returns VOL_TTL_STABLE_MS for stable', () => {
    expect(deriveTTL('stable')).toBe(VOL_TTL_STABLE_MS)
  })

  it('returns VOL_TTL_VOLATILE_MS for volatile', () => {
    expect(deriveTTL('volatile')).toBe(VOL_TTL_VOLATILE_MS)
  })

  it('returns 0 for ephemeral', () => {
    expect(deriveTTL('ephemeral')).toBe(0)
  })
})

describe('computeScore', () => {
  it('stable key: high access, no changes, old last_changed_at → score < 0.4, tier stable, TTL = stable', () => {
    const entry = { key: '/api/stable', change_count: 0, access_count: 100, last_changed_at: FAR_PAST }
    const score = computeScore(entry, NOW)
    expect(score).toBeLessThan(0.4)
    expect(classifyTier(score)).toBe('stable')
    expect(deriveTTL('stable')).toBe(VOL_TTL_STABLE_MS)
  })

  it('volatile key: moderate changes, moderate access, changed 2 min ago → score in [0.4, 0.8)', () => {
    const entry = { key: '/api/volatile', change_count: 5, access_count: 10, last_changed_at: TWO_MIN_AGO }
    const score = computeScore(entry, NOW)
    expect(score).toBeGreaterThanOrEqual(0.4)
    expect(score).toBeLessThan(VOL_P2P_GATE)
    expect(classifyTier(score)).toBe('volatile')
    expect(deriveTTL('volatile')).toBe(VOL_TTL_VOLATILE_MS)
  })

  it('high-volatility key: max changes, no access, changed just now → score >= 0.8, tier ephemeral, TTL = 0', () => {
    const entry = { key: '/api/ephemeral', change_count: 10, access_count: 0, last_changed_at: NOW }
    const score = computeScore(entry, NOW)
    expect(score).toBeGreaterThanOrEqual(VOL_P2P_GATE)
    expect(classifyTier(score)).toBe('ephemeral')
    expect(deriveTTL('ephemeral')).toBe(0)
  })

  it('output is always in [0, 1] — never exceeds bounds regardless of input', () => {
    const extreme = { key: '/api/x', change_count: 1_000_000, access_count: 0, last_changed_at: NOW }
    const score = computeScore(extreme, NOW)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('change_frequency saturates at 1.0 when change_count >= VOL_CHANGE_BASELINE', () => {
    const atBaseline = { key: '/api/a', change_count: VOL_CHANGE_BASELINE, access_count: 0, last_changed_at: NOW }
    const above = { key: '/api/b', change_count: VOL_CHANGE_BASELINE * 100, access_count: 0, last_changed_at: NOW }
    expect(computeScore(atBaseline, NOW)).toBeCloseTo(computeScore(above, NOW), 8)
  })

  it('access_frequency saturates at 1.0 when access_count >= VOL_ACCESS_BASELINE', () => {
    const atBaseline = { key: '/api/a', change_count: 0, access_count: VOL_ACCESS_BASELINE, last_changed_at: FAR_PAST }
    const above = { key: '/api/b', change_count: 0, access_count: VOL_ACCESS_BASELINE * 100, last_changed_at: FAR_PAST }
    expect(computeScore(atBaseline, NOW)).toBeCloseTo(computeScore(above, NOW), 8)
  })

  it('injecting now parameter produces deterministic results', () => {
    const entry = { key: '/api/det', change_count: 3, access_count: 20, last_changed_at: NOW - 60_000 }
    const s1 = computeScore(entry, NOW)
    const s2 = computeScore(entry, NOW)
    expect(s1).toBe(s2)
  })

  it('boundary: score exactly at 0.4 maps to volatile', () => {
    expect(classifyTier(0.4)).toBe('volatile')
  })

  it('boundary: score exactly at 0.8 maps to ephemeral', () => {
    expect(classifyTier(0.8)).toBe('ephemeral')
  })

  it('zero-history entry (no changes, no access, old) scores 0.3 — stable tier', () => {
    // change_freq = 0, recency_decay = 0, access_freq = 0
    // raw = 0*0.4 + 0*0.3 + 0.3*(1-0) = 0.3
    const entry = { key: '/api/cold', change_count: 0, access_count: 0, last_changed_at: FAR_PAST }
    const score = computeScore(entry, NOW)
    expect(score).toBeCloseTo(0.3, 5)
    expect(classifyTier(score)).toBe('stable')
  })

  it('fully decayed entry with max access scores near 0 — most stable possible', () => {
    const entry = { key: '/api/superstable', change_count: 0, access_count: VOL_ACCESS_BASELINE, last_changed_at: FAR_PAST }
    const score = computeScore(entry, NOW)
    // change_freq=0, recency_decay=0, access_freq=1 → raw = 0.3*(1-1) = 0
    expect(score).toBeCloseTo(0, 5)
    expect(classifyTier(score)).toBe('stable')
  })
})
