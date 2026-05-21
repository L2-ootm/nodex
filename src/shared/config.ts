// src/shared/config.ts — imported by sw/, server/, and dashboard/
// All tunable constants centralized here. Downstream phases override by editing this file only.

export const CACHE_URL_PREFIX = '/api/'
export const CACHE_NAME = 'nodex-v1'
export const CACHE_MAX_BYTES = 30 * 1024 * 1024  // 30MB hard cap (D-11)
export const CACHE_MAX_ENTRIES = 500              // LRU entry budget (discretionary)

export const IDB_NAME = 'nodex-db'
export const IDB_VERSION = 1
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
