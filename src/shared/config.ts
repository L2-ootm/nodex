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
export const DEFAULT_APP_ORIGIN = 'http://localhost:4173'
export const DEFAULT_API_ORIGIN = 'http://localhost:3001'
export const DEFAULT_SIGNALING_URL = `ws://localhost:${SIGNALING_PORT}/ws`
export const SIGNALING_URL = DEFAULT_SIGNALING_URL
export const DEFAULT_SIGNALING_ROOM = 'default'
export const PEER_FANOUT = 3
export const P2P_FETCH_TIMEOUT_MS = 200
export const DC_GOSSIP_ID = 0
export const DC_CACHE_FETCH_ID = 1
export type IceTransportPolicy = 'all' | 'relay'
export interface IceServerConfig {
  urls: string | string[]
  username?: string
  credential?: string
}

// Structural equivalent of RTCIceServer[] — compatible with DOM lib without requiring it
export const ICE_SERVERS: IceServerConfig[] = [
  { urls: 'stun:stun.l.google.com:19302' },
]
export const DEFAULT_ICE_TRANSPORT_POLICY: IceTransportPolicy = 'all'

export interface NodexRuntimeConfigOverrides {
  appOrigin?: string
  apiOrigin?: string
  signalingUrl?: string
  iceServers?: IceServerConfig[]
  iceServersJson?: string
  forceRelay?: boolean | string
  apiToken?: string
}

export interface NodexRuntimeConfig {
  appOrigin: string
  apiOrigin: string
  signalingUrl: string
  iceServers: IceServerConfig[]
  forceRelay: boolean
  iceTransportPolicy: IceTransportPolicy
  apiToken: string
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function normalizeIceServer(value: unknown): IceServerConfig | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const urls = record['urls']
  const normalizedUrls = typeof urls === 'string'
    ? nonEmptyString(urls)
    : Array.isArray(urls)
      ? urls.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : undefined

  if (!normalizedUrls || (Array.isArray(normalizedUrls) && normalizedUrls.length === 0)) {
    return null
  }

  return {
    urls: normalizedUrls,
    ...(nonEmptyString(record['username']) ? { username: nonEmptyString(record['username']) } : {}),
    ...(nonEmptyString(record['credential']) ? { credential: nonEmptyString(record['credential']) } : {}),
  }
}

function cloneIceServers(servers: IceServerConfig[]): IceServerConfig[] {
  return servers.map((server) => ({
    ...server,
    urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
  }))
}

export function parseIceServersJson(
  iceServersJson: string | undefined,
  fallback: IceServerConfig[] = ICE_SERVERS
): IceServerConfig[] {
  if (!iceServersJson || iceServersJson.trim().length === 0) {
    return cloneIceServers(fallback)
  }

  try {
    const parsed = JSON.parse(iceServersJson) as unknown
    if (!Array.isArray(parsed)) return cloneIceServers(fallback)
    const servers = parsed
      .map(normalizeIceServer)
      .filter((server): server is IceServerConfig => server !== null)
    return servers.length > 0 ? servers : cloneIceServers(fallback)
  } catch {
    return cloneIceServers(fallback)
  }
}

function booleanFromConfig(value: boolean | string | undefined): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return false
  return ['1', 'true', 'yes', 'relay'].includes(value.trim().toLowerCase())
}

function readGlobalRuntimeConfig(): NodexRuntimeConfigOverrides {
  const globalRecord = globalThis as unknown as Record<string, unknown>
  const maybeConfig =
    globalRecord['__NodexRuntimeConfig'] ??
    globalRecord['__nodexRuntimeConfig']

  if (!maybeConfig || typeof maybeConfig !== 'object') return {}
  return maybeConfig as NodexRuntimeConfigOverrides
}

export function resolveNodexRuntimeConfig(
  overrides: NodexRuntimeConfigOverrides = {}
): NodexRuntimeConfig {
  const globalConfig = readGlobalRuntimeConfig()
  const merged: NodexRuntimeConfigOverrides = { ...globalConfig, ...overrides }
  const forceRelay = booleanFromConfig(merged.forceRelay)

  return {
    appOrigin: nonEmptyString(merged.appOrigin) ?? DEFAULT_APP_ORIGIN,
    apiOrigin: nonEmptyString(merged.apiOrigin) ?? DEFAULT_API_ORIGIN,
    signalingUrl: nonEmptyString(merged.signalingUrl) ?? DEFAULT_SIGNALING_URL,
    iceServers: merged.iceServers
      ? cloneIceServers(merged.iceServers)
      : parseIceServersJson(merged.iceServersJson),
    forceRelay,
    iceTransportPolicy: forceRelay ? 'relay' : DEFAULT_ICE_TRANSPORT_POLICY,
    apiToken: nonEmptyString(merged.apiToken) ?? '',
  }
}

export function buildSignalingUrl(room: string, signalingUrl = DEFAULT_SIGNALING_URL): string {
  const url = new URL(signalingUrl)
  url.searchParams.set('room', room)
  return url.toString()
}

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
