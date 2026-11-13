import { afterEach, describe, expect, it, vi } from 'vitest'
import { _resetTrustedClockForTest, anchorTrustedClock, trustedNow } from './trusted-clock.js'

afterEach(() => { _resetTrustedClockForTest(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('trusted clock', () => {
  it('falls back to Date.now() before any anchor', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_234_567)
    expect(trustedNow()).toBe(1_234_567)
  })

  it('ignores a wall-clock jump after anchoring', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1_000)
    anchorTrustedClock(5_000_000)
    vi.spyOn(Date, 'now').mockReturnValue(9_999_999_999)
    vi.spyOn(performance, 'now').mockReturnValue(3_000)
    expect(trustedNow()).toBe(5_002_000)
  })

  it('never moves backward on an older signed proof', () => {
    const perf = vi.spyOn(performance, 'now').mockReturnValue(0)
    anchorTrustedClock(5_000_000)
    perf.mockReturnValue(10_000)
    anchorTrustedClock(5_003_000) // older than trusted 5_010_000
    expect(trustedNow()).toBe(5_010_000)
    anchorTrustedClock(5_020_000) // newer is accepted
    expect(trustedNow()).toBe(5_020_000)
  })

  it('rejects non-positive and non-finite anchors', () => {
    for (const bad of [0, -1, NaN, Infinity]) anchorTrustedClock(bad)
    vi.spyOn(Date, 'now').mockReturnValue(42)
    expect(trustedNow()).toBe(42)
  })
})
