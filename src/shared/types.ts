// src/shared/types.ts — MetricsEvent and CacheMeta type contracts
// schema_version is a literal type (1) so TypeScript enforces the value at compile time
// NodexSchema exported for use in src/sw/idb.ts with idb's typed openDB<NodexSchema>()

import type { DBSchema } from 'idb'

export interface MetricsEvent {
  schema_version: 1
  type: 'sw-cache' | 'peer-fetch' | 'server-fallback' | 'gossip-propagation' | 'admission-rejected'
  key: string              // cache path key (e.g., '/api/products/42')
  latency_ms: number       // self.performance.now() delta, rounded to 2dp
  source_node_id: string   // UUID, 'local' alias for Phase 1
  timestamp: number        // Date.now() epoch ms
  // Phase 3 additions — gossip propagation metrics
  msgId?: string           // gossip message ID for deduplication tracking
  t_invalidate?: number    // epoch ms when invalidation was first created
  t_received?: number      // epoch ms when this node received the gossip message
  hop_count?: number       // number of hops from origin (GOSSIP_TTL - msg.ttl)
  // Consistency admission gate — populated when type='admission-rejected'
  rejection_reason?: string  // AdmissionRejectReason from consistency.ts
  rejection_source?: 'cache' | 'peer' | 'server'  // which read path triggered the rejection
}

export type CandidatePathType = 'host' | 'srflx' | 'relay' | 'unknown'
export type PeerRole = 'local' | 'long-range'

export interface PeerTelemetrySample {
  schema_version: 1
  type: 'webrtc-edge'
  room_id: string
  topology_label: string
  node_id: string
  peer_id: string
  role: PeerRole
  selected_candidate_type: CandidatePathType
  local_candidate_type?: CandidatePathType
  remote_candidate_type?: CandidatePathType
  ice_connection_state: string
  connection_state: string
  data_channel_state: string
  current_round_trip_time_ms?: number
  bytes_sent?: number
  bytes_received?: number
  timestamp: number
  // Phase 7 / Phase 21 timing fields — all durations in ms
  ice_gather_duration_ms?: number   // time from ICE gathering start to complete
  dc_open_latency_ms?: number       // time from DataChannel creation to first open event
  signaling_success?: boolean       // true when at least one DataChannel opened
}

export interface StoragePressureSample {
  schema_version: 1
  type: 'storage-pressure'
  room_id: string
  topology_label: string
  node_id: string
  usage_bytes: number | null
  quota_bytes: number | null
  usage_ratio: number | null
  timestamp: number
}

export interface CacheMeta {
  path: string
  seq: number
  accessed_at: number      // epoch ms
  byte_size: number        // estimated response body bytes
  ttl_ms?: number          // optional TTL in ms derived from volatility tier; 0 = no caching; absent = no expiry
  cached_at?: number       // epoch ms when the entry was written; paired with ttl_ms for expiry check
  validated_at?: number    // server freshness-proof timestamp; authenticated in payload AAD
}

export interface VolatilityEntry {
  key: string
  change_count: number
  last_changed_at: number  // epoch ms — timestamp of most recent invalidation event
  access_count: number
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
  'nodex-volatility': {
    key: string
    value: VolatilityEntry
  }
}

// Phase 2 — Signaling + WebRTC message type contracts
export type SignalingMsgType = 'JOIN' | 'JOIN_ACK' | 'PEERS_LIST' | 'OFFER' | 'ANSWER' | 'ICE_CANDIDATE' | 'LEAVE' | 'BROADCAST'

export interface SignalingMessage {
  type: SignalingMsgType
  from?: string
  to?: string
  sdp?: { type: 'offer' | 'answer'; sdp: string }
  candidate?: { candidate: string; sdpMid?: string; sdpMLineIndex?: number }
  peers?: string[]
  polite?: boolean
  key?: string
  seq?: number
}

export type SwMessageType =
  | 'GET_NODE_ID'
  | 'NODE_ID'
  | 'P2P_FETCH'
  | 'P2P_FETCH_RESPONSE'
  | 'P2P_FETCH_SERVE'
  | 'FLUSH_BUFFER'
  | 'GOSSIP_INVALIDATE'
  | 'IMPORT_SESSION_KEY'
  | 'REVALIDATE_KEY'
  | 'GET_CACHE_STATE'
  | 'SET_RUNTIME_FLAGS'

export interface SwMessage {
  type: SwMessageType
  key?: string
  nodeId?: string
  payload?: string
  seq?: number
  found?: boolean
  // Phase 3 additions — gossip + encryption
  msgId?: string
  ttl?: number
  originNodeId?: string
  t_invalidate?: number
  keyId?: string
  keyBytes?: ArrayBuffer | Uint8Array
  flags?: {
    disableP2P?: boolean
    disableCacheRead?: boolean
  }
}

// Phase 3 — Gossip invalidation message propagated over RTCDataChannel (gossip channel)
export interface GossipMessage {
  type: 'GOSSIP_INVALIDATE'
  msgId: string            // UUID — used for seen-set deduplication (T-03-01)
  key: string              // cache key being invalidated (path, e.g. '/api/products/42')
  seq: number              // server-issued monotonic sequence number for the key
  ttl: number              // remaining hops; decremented per forward; drop when 0
  originNodeId: string     // UUID of the node that originated the invalidation
  t_invalidate: number     // epoch ms when the invalidation was created at origin
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
