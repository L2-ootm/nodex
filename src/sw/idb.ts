// src/sw/idb.ts
// IndexedDB open-once pattern for the Service Worker tier
// Uses the typed idb wrapper with NodexSchema for compile-time store safety
//
// Pattern 2 (RESEARCH.md): Open the IDB connection once, store the Promise<IDBPDatabase>
// at module scope, and await it in all subsequent reads/writes. Never call openDB() inside
// the fetch event handler — that adds per-request async overhead.

import { openDB, type IDBPDatabase } from 'idb'
import type { NodexSchema } from '../shared/types.js'
import {
  IDB_NAME,
  IDB_VERSION,
  META_STORE,
  METRICS_BUFFER_STORE,
} from '../shared/config.js'

// Module-level promise — initialized lazily on first getDb() call, reused on all subsequent calls
let _db: Promise<IDBPDatabase<NodexSchema>> | null = null

/**
 * Return the typed IDB database promise.
 * Opens the database on the first call (lazy initialization).
 * All subsequent calls return the same Promise — no duplicate openDB() calls.
 */
export function getDb(): Promise<IDBPDatabase<NodexSchema>> {
  if (!_db) {
    _db = openDB<NodexSchema>(IDB_NAME, IDB_VERSION, {
      upgrade(db) {
        // nodex-meta: keyed by path (string), indexed by accessed_at for LRU eviction queries
        if (!db.objectStoreNames.contains(META_STORE)) {
          const metaStore = db.createObjectStore(META_STORE, { keyPath: 'path' })
          metaStore.createIndex('accessed_at', 'accessed_at')
        }
        // nodex-metrics-buffer: auto-increment integer key, stores MetricsEvent entries (FIFO)
        if (!db.objectStoreNames.contains(METRICS_BUFFER_STORE)) {
          db.createObjectStore(METRICS_BUFFER_STORE, { autoIncrement: true })
        }
      },
    })
  }
  return _db
}
