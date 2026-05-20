// src/sw/freshness.test.ts
// Unit tests for the in-memory sequence number freshness module
// freshness.ts uses no browser globals — pure TypeScript logic testable under vitest

import { describe, it, expect, beforeEach } from 'vitest'
import type { CacheMeta } from '../shared/types.js'
import { seedSeqMap, updateSeq, isFresh, getLatestSeq } from './freshness.js'

describe('freshness', () => {
  beforeEach(() => {
    // Reset module-level latestSeqMap before each test
    seedSeqMap([])
  })

  it('Test 1: isFresh returns true when latestSeqMap has no entry for that path (empty Map → any cached seq is treated as fresh)', () => {
    // Empty map → no known latest seq → cached entry is treated as fresh
    expect(isFresh('/api/p/1', 3)).toBe(true)
  })

  it('Test 2: After updateSeq, isFresh returns true when cachedSeq equals the latest seq', () => {
    updateSeq('/api/p/1', 5)
    expect(isFresh('/api/p/1', 5)).toBe(true)
  })

  it('Test 3: After updateSeq, isFresh returns false when cachedSeq is less than latest seq (stale entry)', () => {
    updateSeq('/api/p/1', 5)
    expect(isFresh('/api/p/1', 4)).toBe(false)
  })

  it('Test 4: updateSeq does NOT lower the stored value when current is already higher (monotonic — only increases)', () => {
    updateSeq('/api/p/1', 5)
    updateSeq('/api/p/1', 3)
    // Should remain 5, not drop to 3
    expect(getLatestSeq('/api/p/1')).toBe(5)
    expect(isFresh('/api/p/1', 4)).toBe(false)  // still stale because latest is 5
  })

  it('Test 5: seedSeqMap seeds the in-memory Map correctly from CacheMeta array', () => {
    const entries: CacheMeta[] = [{ path: '/api/p/1', seq: 7, accessed_at: 0, byte_size: 0 }]
    seedSeqMap(entries)
    expect(isFresh('/api/p/1', 6)).toBe(false)  // 6 < 7 → stale
    expect(isFresh('/api/p/1', 7)).toBe(true)   // 7 >= 7 → fresh
  })
})
