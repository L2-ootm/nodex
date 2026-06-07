// src/p2p/evidence-capture.ts
// Research-grade evidence artifact for real two-device P2P validation runs.
// Pure classification logic is exported separately for unit testing.

import type { MetricsEvent, PeerTelemetrySample, StoragePressureSample } from '../shared/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EvidenceClassification = 'pass' | 'partial' | 'fail' | 'not_measured'
export type DeviceRole = 'seeder' | 'receiver' | 'unknown'

export interface P2PEvidenceArtifact {
  schema_version: 1
  run_id: string
  timestamp_iso: string
  commit_hash: string
  device_role: DeviceRole
  topology_label: string
  browser_user_agent: string
  platform: string
  viewport_width: number
  viewport_height: number
  touch_support: boolean
  mobile_hint: boolean
  signaling_endpoint: string
  room_id: string
  seeded_key: string | null
  webrtc_connection_state_timeline: PeerTelemetrySample[]
  ice_candidate_type: string
  webrtc_edge_formed: boolean
  peer_fetch_occurred: boolean
  peer_fetch_latency_ms: number | null
  server_fallback_latency_ms: number | null
  cache_path: 'sw-cache' | 'peer-fetch' | 'server-fallback' | 'unknown'
  console_errors: string[]
  metrics_events_count: number
  metrics_events_sample: MetricsEvent[]
  peer_telemetry: PeerTelemetrySample[]
  storage_pressure: StoragePressureSample | null
  runtime_config: Record<string, unknown>
  classification: EvidenceClassification
  classification_reason: string
}

// ---------------------------------------------------------------------------
// Classification (pure — no DOM, testable under vitest)
// ---------------------------------------------------------------------------

export interface ClassificationInput {
  webrtcEdgeFormed: boolean
  peerFetchOccurred: boolean
  connectionAttempted: boolean
  iceCandidateType: string
}

export function classifyRun(input: ClassificationInput): {
  classification: EvidenceClassification
  reason: string
} {
  if (!input.connectionAttempted) {
    return {
      classification: 'not_measured',
      reason:
        'No WebRTC connection was attempted. Signaling may not have reached this peer or the protocol did not initialize.',
    }
  }

  if (!input.webrtcEdgeFormed) {
    return {
      classification: 'fail',
      reason:
        'WebRTC connection was attempted but the data-channel edge did not form. Check NAT/ICE/STUN, console errors, and whether the remote peer joined the same room.',
    }
  }

  if (input.webrtcEdgeFormed && input.peerFetchOccurred) {
    if (input.iceCandidateType === 'unknown') {
      return {
        classification: 'partial',
        reason:
          'Peer-fetch occurred and WebRTC edge formed, but ICE candidate type is unresolved. The data path works but the network class (host/srflx/relay) cannot be confirmed from this run.',
      }
    }
    return {
      classification: 'pass',
      reason: `WebRTC edge formed (${input.iceCandidateType}) and peer-fetch confirmed. P2P data path validated for this topology.`,
    }
  }

  // Edge formed but no peer-fetch
  return {
    classification: 'partial',
    reason:
      'WebRTC edge formed but no peer-fetch was observed on this device. The remote peer may not have had the key seeded, or Device A fetched from server-fallback before Device B connected.',
  }
}

// ---------------------------------------------------------------------------
// Console error capture (module-level accumulator, init once)
// ---------------------------------------------------------------------------

const _capturedErrors: string[] = []
let _consoleHooked = false

export function initConsoleErrorCapture(): void {
  if (_consoleHooked || typeof console === 'undefined') return
  _consoleHooked = true

  const _originalError = console.error.bind(console)
  console.error = (...args: unknown[]): void => {
    const msg = args
      .map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : String(a)))
      .join(' ')
    _capturedErrors.push(msg)
    _originalError(...args)
  }
}

export function getCapturedErrors(): string[] {
  return [..._capturedErrors]
}

// ---------------------------------------------------------------------------
// Device role from URL params
// ---------------------------------------------------------------------------

function getDeviceRole(): DeviceRole {
  if (typeof window === 'undefined') return 'unknown'
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('nodexDeviceRole')?.toLowerCase().trim()
  if (raw === 'seeder') return 'seeder'
  if (raw === 'receiver') return 'receiver'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Build-time commit hash (injected by vite.config.ts define)
// ---------------------------------------------------------------------------

declare const __NODEX_COMMIT_HASH__: string | undefined

function getCommitHash(): string {
  try {
    return typeof __NODEX_COMMIT_HASH__ !== 'undefined' ? __NODEX_COMMIT_HASH__ : 'unknown'
  } catch {
    return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// captureEvidence — async; gathers all signals from window hooks
// ---------------------------------------------------------------------------

interface WindowWithNodexHooks {
  __nodexPeerTelemetry?: () => Promise<PeerTelemetrySample[]>
  __nodexPeerTelemetrySamples?: () => PeerTelemetrySample[]
  __nodexStoragePressure?: () => Promise<StoragePressureSample>
  __nodexRuntimeConfig?: () => Record<string, unknown>
  __nodexLastP2PCapture?: () => { key: string; seq: number; ts: number } | null
  __nodexRoomId?: string
  __nodexTopologyLabel?: string
  __nodexCollectedMetricsEvents?: () => MetricsEvent[]
}

export async function captureEvidence(): Promise<P2PEvidenceArtifact> {
  const w = window as unknown as WindowWithNodexHooks

  // Peer telemetry — live stats if available
  let peerTelemetry: PeerTelemetrySample[] = []
  try {
    if (typeof w.__nodexPeerTelemetry === 'function') {
      peerTelemetry = await w.__nodexPeerTelemetry()
    } else if (typeof w.__nodexPeerTelemetrySamples === 'function') {
      peerTelemetry = w.__nodexPeerTelemetrySamples()
    }
  } catch { /* best-effort */ }

  // Storage pressure
  let storagePressure: StoragePressureSample | null = null
  try {
    if (typeof w.__nodexStoragePressure === 'function') {
      storagePressure = await w.__nodexStoragePressure()
    }
  } catch { /* best-effort */ }

  // Runtime config
  const runtimeConfig: Record<string, unknown> = {}
  try {
    if (typeof w.__nodexRuntimeConfig === 'function') {
      Object.assign(runtimeConfig, w.__nodexRuntimeConfig())
    }
  } catch { /* best-effort */ }

  // Metrics events collected by dashboard
  let metricsEvents: MetricsEvent[] = []
  try {
    if (typeof w.__nodexCollectedMetricsEvents === 'function') {
      metricsEvents = w.__nodexCollectedMetricsEvents()
    }
  } catch { /* best-effort */ }

  // Last P2P capture (for seeded key)
  const lastCapture = (typeof w.__nodexLastP2PCapture === 'function') ? w.__nodexLastP2PCapture() : null

  const roomId = (typeof w.__nodexRoomId === 'string') ? w.__nodexRoomId : 'unknown'
  const topologyLabel = (typeof w.__nodexTopologyLabel === 'string') ? w.__nodexTopologyLabel : 'unknown'
  const signalingEndpoint = typeof runtimeConfig['signalingUrl'] === 'string' ? runtimeConfig['signalingUrl'] : 'unknown'

  // Derive classification inputs from telemetry
  const connectionAttempted = peerTelemetry.length > 0
  const webrtcEdgeFormed = peerTelemetry.some(
    (s) => s.connection_state === 'connected' || s.data_channel_state === 'open'
  )

  // peer-fetch from metrics events
  const peerFetchEvents = metricsEvents.filter((e) => e.type === 'peer-fetch')
  const peerFetchOccurred = peerFetchEvents.length > 0
  const peerFetchLatency = peerFetchOccurred
    ? Math.min(...peerFetchEvents.map((e) => e.latency_ms))
    : null

  const serverFallbackEvents = metricsEvents.filter((e) => e.type === 'server-fallback')
  const serverFallbackLatency =
    serverFallbackEvents.length > 0
      ? Math.min(...serverFallbackEvents.map((e) => e.latency_ms))
      : null

  // ICE candidate type from most-connected telemetry sample
  const connectedSample = peerTelemetry.find(
    (s) => s.connection_state === 'connected' || s.data_channel_state === 'open'
  )
  const iceCandidateType = connectedSample?.selected_candidate_type ?? 'unknown'

  // Cache path summary
  let cachePath: P2PEvidenceArtifact['cache_path'] = 'unknown'
  if (peerFetchOccurred) cachePath = 'peer-fetch'
  else if (metricsEvents.some((e) => e.type === 'sw-cache')) cachePath = 'sw-cache'
  else if (serverFallbackEvents.length > 0) cachePath = 'server-fallback'

  const { classification, reason } = classifyRun({
    webrtcEdgeFormed,
    peerFetchOccurred,
    connectionAttempted,
    iceCandidateType: String(iceCandidateType),
  })

  // Device hints
  const touchSupport = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0
  const mobileHint =
    typeof navigator !== 'undefined' &&
    /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

  return {
    schema_version: 1,
    run_id: crypto.randomUUID(),
    timestamp_iso: new Date().toISOString(),
    commit_hash: getCommitHash(),
    device_role: getDeviceRole(),
    topology_label: topologyLabel,
    browser_user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    platform:
      typeof navigator !== 'undefined'
        ? (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? 'unknown'
        : 'unknown',
    viewport_width: typeof window !== 'undefined' ? window.innerWidth : 0,
    viewport_height: typeof window !== 'undefined' ? window.innerHeight : 0,
    touch_support: touchSupport,
    mobile_hint: mobileHint,
    signaling_endpoint: signalingEndpoint,
    room_id: roomId,
    seeded_key: lastCapture?.key ?? null,
    webrtc_connection_state_timeline: peerTelemetry,
    ice_candidate_type: String(iceCandidateType),
    webrtc_edge_formed: webrtcEdgeFormed,
    peer_fetch_occurred: peerFetchOccurred,
    peer_fetch_latency_ms: peerFetchLatency,
    server_fallback_latency_ms: serverFallbackLatency,
    cache_path: cachePath,
    console_errors: getCapturedErrors(),
    metrics_events_count: metricsEvents.length,
    metrics_events_sample: metricsEvents.slice(0, 50),
    peer_telemetry: peerTelemetry,
    storage_pressure: storagePressure,
    runtime_config: runtimeConfig,
    classification,
    classification_reason: reason,
  }
}
