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
