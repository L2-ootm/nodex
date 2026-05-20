// src/sw/freshness.ts
// In-memory sequence number freshness tracking
// Pure TypeScript — no browser globals. Testable under vitest in Node.js environment.
//
// Design (D-09): In-memory Map<path, number> tracks the highest sequence number the SW
// has observed for each cached path. On a cache hit, the SW compares the cached entry's
// seq against the map's latest observed seq. If cached seq is lower, the entry is stale.
//
// The Map is warm in memory for O(1) lookup in the fetch handler hot path.
// It is seeded from IndexedDB on SW activation (Pattern 7 from RESEARCH.md).

import type { CacheMeta } from '../shared/types.js'

// Module-level state — persists for the lifetime of the SW registration
const latestSeqMap = new Map<string, number>()

/**
 * Seed the in-memory seq Map from IDB CacheMeta entries.
 * Called on SW activate after reading all entries from nodex-meta store.
 * When called with an empty array, clears the map (used in tests to reset state).
 */
export function seedSeqMap(entries: CacheMeta[]): void {
  latestSeqMap.clear()
  for (const entry of entries) {
    updateSeq(entry.path, entry.seq)
  }
}

/**
 * Update the latest observed seq for a path.
 * Monotonic: only increases — never lowers the stored value.
 * Called after a server fallback fetch (self-seeding) and during activate seeding.
 */
export function updateSeq(path: string, seq: number): void {
  const current = latestSeqMap.get(path) ?? 0
  if (seq > current) {
    latestSeqMap.set(path, seq)
  }
}

/**
 * Check if a cached entry with the given seq is still fresh.
 * Returns true if cachedSeq >= latest observed seq for the path.
 * Returns true (fresh) when no entry exists in the map — empty map means
 * no invalidation has been observed, so any cached entry is treated as fresh.
 */
export function isFresh(path: string, cachedSeq: number): boolean {
  const latestSeq = latestSeqMap.get(path) ?? cachedSeq
  return cachedSeq >= latestSeq
}

/**
 * Return the latest observed seq for a path.
 * Returns 0 if no entry exists (meaning no fetch/invalidation has been observed).
 * Used for test introspection and debugging.
 */
export function getLatestSeq(path: string): number {
  return latestSeqMap.get(path) ?? 0
}
