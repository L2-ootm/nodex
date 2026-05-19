// src/shared/types.ts — MetricsEvent and CacheMeta type contracts
// schema_version is a literal type (1) so TypeScript enforces the value at compile time
// NodexSchema exported for use in src/sw/idb.ts with idb's typed openDB<NodexSchema>()

import type { DBSchema } from 'idb'

export interface MetricsEvent {
  schema_version: 1
  type: 'sw-cache' | 'peer-fetch' | 'server-fallback'
  key: string              // cache path key (e.g., '/api/products/42')
  latency_ms: number       // self.performance.now() delta, rounded to 2dp
  source_node_id: string   // UUID, 'local' alias for Phase 1
  timestamp: number        // Date.now() epoch ms
}

export interface CacheMeta {
  path: string
  seq: number
  accessed_at: number      // epoch ms
  byte_size: number        // estimated response body bytes
}

export interface NodexSchema extends DBSchema {
  'nodex-meta': {
    key: string
    value: CacheMeta
    indexes: { accessed_at: number }
  }
  'nodex-metrics-buffer': {
    key: number
    value: MetricsEvent
  }
}
