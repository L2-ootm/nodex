// src/shared/config.ts — imported by sw/, server/, and dashboard/
// All tunable constants centralized here. Downstream phases override by editing this file only.

export const CACHE_URL_PREFIX = '/api/'
export const CACHE_NAME = 'nodex-v1'
export const CACHE_MAX_BYTES = 30 * 1024 * 1024  // 30MB hard cap (D-11)
export const CACHE_MAX_ENTRIES = 500              // LRU entry budget (discretionary)

export const IDB_NAME = 'nodex-db'
export const IDB_VERSION = 2
export const META_STORE = 'nodex-meta'
export const METRICS_BUFFER_STORE = 'nodex-metrics-buffer'
export const METRICS_BUFFER_MAX = 1000            // FIFO max (D-15)

export const METRICS_CHANNEL_NAME = 'nodex-metrics'  // BroadcastChannel name (D-14)

// Phase 2 additions — Signaling + WebRTC P2P
export const SIGNALING_PORT = 3002
export const SIGNALING_URL = `ws://localhost:${SIGNALING_PORT}/ws`
export const PEER_FANOUT = 3
export const P2P_FETCH_TIMEOUT_MS = 200
export const DC_GOSSIP_ID = 0
export const DC_CACHE_FETCH_ID = 1
// Structural equivalent of RTCIceServer[] — compatible with DOM lib without requiring it
export const ICE_SERVERS: { urls: string | string[]; username?: string; credential?: string }[] = [
  { urls: 'stun:stun.l.google.com:19302' },
]

// Phase 3 additions — Gossip Protocol + Encryption
// GOSSIP_TTL: max hops = ceil(log2(10)) + 1 = 5 (covers a 10-node network with 1 spare hop)
export const GOSSIP_TTL = Math.ceil(Math.log2(10)) + 1  // evaluates to 5
export const GOSSIP_SEEN_SET_MAX = 1000                  // LruSet eviction ceiling
export const LONG_RANGE_PEER_COUNT = 2                   // long-range peer count for gossip topology
export const ENCRYPTION_KEY_ID = 'default'               // session-derived key identifier

// Phase 4 additions — Volatility Heuristic Classifier
export const VOLATILITY_STORE = 'nodex-volatility'
export const VOL_ALPHA = 0.4        // change_frequency weight
export const VOL_BETA = 0.3         // recency_decay weight
export const VOL_GAMMA = 0.3        // (1 - access_frequency) weight
export const VOL_COLD_START = 0.5   // default score when no ledger entry exists for a key
export const VOL_P2P_GATE = 0.8     // score >= this → server-only, skip P2P distribution
export const VOL_TTL_STABLE_MS = 5 * 60 * 1000    // 300000ms — stable tier TTL
export const VOL_TTL_VOLATILE_MS = 30 * 1000       // 30000ms — volatile tier TTL
export const VOL_TTL_EPHEMERAL_MS = 0              // 0ms — ephemeral tier TTL (no caching)
export const VOL_DECAY_WINDOW_MS = 5 * 60 * 1000   // recency decay window: decays to 0 after this duration
export const VOL_CHANGE_BASELINE = 10              // change_count normalization denominator
export const VOL_ACCESS_BASELINE = 100             // access_count normalization denominator
