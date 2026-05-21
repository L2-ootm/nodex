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

// Phase 2 — Signaling + WebRTC message type contracts
export type SignalingMsgType = 'JOIN' | 'JOIN_ACK' | 'PEERS_LIST' | 'OFFER' | 'ANSWER' | 'ICE_CANDIDATE' | 'LEAVE'

export interface SignalingMessage {
  type: SignalingMsgType
  from?: string
  to?: string
  sdp?: { type: 'offer' | 'answer'; sdp: string }
  candidate?: { candidate: string; sdpMid?: string; sdpMLineIndex?: number }
  peers?: string[]
  polite?: boolean
}

export type SwMessageType = 'GET_NODE_ID' | 'NODE_ID' | 'P2P_FETCH' | 'P2P_FETCH_RESPONSE' | 'FLUSH_BUFFER'

export interface SwMessage {
  type: SwMessageType
  key?: string
  nodeId?: string
  payload?: string
  seq?: number
  found?: boolean
}

export interface PeerFetchRequest {
  type: 'CACHE_FETCH_REQUEST'
  reqId: string
  key: string
}

export interface PeerFetchResponse {
  type: 'CACHE_FETCH_RESPONSE'
  reqId: string
  found: boolean
  payload?: string
  seq?: number
}
