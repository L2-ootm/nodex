// src/sw/cache.test.ts — Unit tests for evictIfNeeded (pure function, no browser APIs)
import { describe, it, expect } from 'vitest'
import { evictIfNeeded } from './cache.js'
import { CACHE_MAX_BYTES } from '../shared/config.js'
import type { CacheMeta } from '../shared/types.js'

const MB = 1024 * 1024

// Helper to build a CacheMeta entry
function meta(path: string, accessed_at: number, byte_size: number): CacheMeta {
  return { path, seq: 1, accessed_at, byte_size }
}

describe('evictIfNeeded', () => {
  it('returns the LRU path when totalBytes + newByteSize exceeds cap', () => {
    // Total existing = 30MB - 100, new = 200 → totalBytes + newByteSize = 30MB + 100 → evict
    const existing: CacheMeta[] = [
      meta('/api/products/1', 1000, (CACHE_MAX_BYTES - 100) - MB), // older
      meta('/api/products/2', 2000, MB),                           // newer
    ]
    // Total byte_size sum = (CACHE_MAX_BYTES - 100 - MB) + MB = CACHE_MAX_BYTES - 100
    const result = evictIfNeeded(existing, 200)
    expect(result).toBe('/api/products/1') // oldest accessed_at → LRU
  })

  it('returns null when no eviction is needed', () => {
    const existing: CacheMeta[] = [
      meta('/api/products/1', 1000, 100),
      meta('/api/products/2', 2000, 100),
    ]
    // Total = 200, newByteSize = 100 → 300 total, well under 30MB
    const result = evictIfNeeded(existing, 100)
    expect(result).toBeNull()
  })

  it('evicts the entry with the lower accessed_at when accessed_at timestamps are equal', () => {
    // Both have same accessed_at — stable sort must pick consistently (index 0 in sort)
    const existing: CacheMeta[] = [
      meta('/api/products/alpha', 5000, CACHE_MAX_BYTES / 2),
      meta('/api/products/beta',  5000, CACHE_MAX_BYTES / 2),
    ]
    // Total = CACHE_MAX_BYTES, newByteSize = 1 → eviction triggered
    const result = evictIfNeeded(existing, 1)
    // Should return one of them (stable sort preserves insertion order → first one)
    expect(result).toBe('/api/products/alpha')
  })
})
