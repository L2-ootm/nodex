import { describe, expect, it } from 'vitest'
import { buildZipfTable, makePrng, rankToKey, sampleZipf } from './zipf'

describe('phase-05 Zipf workload helper', () => {
  it('produces deterministic PRNG values for the same seed', () => {
    const a = makePrng(42)
    const b = makePrng(42)

    expect(a()).toBe(b())
    expect(a()).toBe(b())
  })

  it('builds a normalized Zipf CDF table', () => {
    const table = buildZipfTable(5, 1.0)

    expect(table).toBeInstanceOf(Float64Array)
    expect(table.length).toBe(5)
    expect(table[4]).toBe(1)
    expect(table[0]).toBeGreaterThan(0)
  })

  it('samples integer ranks inside table bounds', () => {
    const table = buildZipfTable(5, 1.0)
    const rng = makePrng(7)

    for (let i = 0; i < 100; i++) {
      const rank = sampleZipf(table, rng)
      expect(Number.isInteger(rank)).toBe(true)
      expect(rank).toBeGreaterThanOrEqual(0)
      expect(rank).toBeLessThan(5)
    }
  })

  it('maps ranks to product API keys', () => {
    expect(rankToKey(0)).toBe('/api/products/1')
    expect(rankToKey(4)).toBe('/api/products/5')
  })
})
