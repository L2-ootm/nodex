// src/p2p/p2p-manager.ts
// Page-side P2P Manager: RTCPeerConnection pool, DataChannels, ICE restart, postMessage bridge.
// RTCPeerConnection is unavailable in SW scope — this module runs on the page only.

import {
  DEFAULT_SIGNALING_ROOM,
  PEER_FANOUT,
  LONG_RANGE_PEER_COUNT,
  DC_GOSSIP_ID,
  DC_CACHE_FETCH_ID,
  METRICS_CHANNEL_NAME,
  buildSignalingUrl,
  resolveNodexRuntimeConfig,
  type NodexRuntimeConfig,
  type IceServerConfig,
} from '../shared/config.js'
import type {
  CandidatePathType,
  GossipMessage,
  PeerFetchRequest,
  PeerFetchResponse,
  PeerRole,
  PeerTelemetrySample,
  SignalingMessage,
  StoragePressureSample,
} from '../shared/types.js'
import { GossipEngine, _resetForTest as _resetGossipForTest } from '../gossip/gossip-engine.js'

// Per-connection state model (includes Perfect Negotiation flags)
interface PeerConnection {
  peerId: string
  pc: RTCPeerConnection
  gossip: RTCDataChannel
  cacheFetch: RTCDataChannel
  polite: boolean
  role: PeerRole
  state: 'connecting' | 'connected' | 'failed' | 'closed'
  makingOffer: boolean
  ignoreOffer: boolean
}

// Module-level state — exported for test introspection and _resetForTest
export const connections = new Map<string, PeerConnection>()
export const pendingRequests = new Map<string, { resolver: (response: PeerFetchResponse) => void; peerId: string }>()
interface SignalingTransport {
  send(payload: string): void
  close(): void
}

let signalingTransport: SignalingTransport | null = null
let signalingPollTimer: number | null = null
let signalingAbortController: AbortController | null = null
export let lastP2PCapture: { key: string; seq: number; ivB64?: string; ctSample?: string; ts: number } | null = null
let nodeId: string | null = null
let roomId: string = DEFAULT_SIGNALING_ROOM
let topologyLabel = 'loopback'
let runtimeConfig: NodexRuntimeConfig | null = null
let turnCredentialExpiresAt = 0
let sessionStartInProgress = false
let leadershipRole: 'leader' | 'follower' | 'unknown' = 'unknown'
let leaderRenewTimer: number | null = null
let followerRetryTimer: number | null = null
const telemetrySamples: PeerTelemetrySample[] = []
const tabId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
  ? crypto.randomUUID()
  : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`

const LEADER_LOCK_KEY = 'nodex-p2p-leader-v1'
const LEADER_LEASE_MS = 2000
const LEADER_RENEW_MS = 500

// GossipEngine wired to connections Map with SW postMessage bridge (GOSP-02)
const gossipEngine = new GossipEngine(
  connections as Map<string, { gossip: RTCDataChannel; state: string }>,
  (event) => {
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel(METRICS_CHANNEL_NAME)
      ch.postMessage(event)
      ch.close()
    }
  },
  (msg: { key: string; seq: number }) => {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.controller?.postMessage({
        type: 'GOSSIP_INVALIDATE',
        key: msg.key,
        seq: msg.seq,
      })
    }
  }
)

// ---------------------------------------------------------------------------
// createChannels — pre-create both DataChannels before any SDP negotiation
// ---------------------------------------------------------------------------

export function createChannels(pc: RTCPeerConnection): {
  gossip: RTCDataChannel
  cacheFetch: RTCDataChannel
} {
  const gossip = pc.createDataChannel('gossip', {
    negotiated: true,
    id: DC_GOSSIP_ID,
    ordered: false,
    maxRetransmits: 0,
  })
  const cacheFetch = pc.createDataChannel('cache-fetch', {
    negotiated: true,
    id: DC_CACHE_FETCH_ID,
    ordered: true,
  })
  return { gossip, cacheFetch }
}

// ---------------------------------------------------------------------------
// selectConnectedPeer — returns first connected peer or null (pure, testable)
// ---------------------------------------------------------------------------

export function selectConnectedPeer(): PeerConnection | null {
  for (const [, conn] of connections) {
    if (conn.state === 'connected') return conn
  }
  return null
}

// ---------------------------------------------------------------------------
// Phase 7 telemetry helpers — pure functions for candidate classification
// ---------------------------------------------------------------------------

type StatsRecord = Record<string, unknown>
type StatsReportLike = Map<string, StatsRecord> | {
  forEach: (callback: (value: StatsRecord, key: string) => void) => void
  get?: (key: string) => StatsRecord | undefined
}

interface TelemetryExtractInput {
  roomId: string
  topologyLabel?: string
  nodeId: string
  peerId: string
  role: PeerRole
  connectionState: string
  iceConnectionState: string
  dataChannelState: string
  timestamp: number
  stats: StatsReportLike
}

interface StoragePressureInput {
  roomId: string
  topologyLabel: string
  nodeId: string
  usage?: number
  quota?: number
  timestamp: number
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeCandidateType(value: unknown): CandidatePathType | 'prflx' | undefined {
  if (value === 'host' || value === 'srflx' || value === 'relay' || value === 'prflx') {
    return value
  }
  return undefined
}

export function candidateTypeFromPair(
  localType: unknown,
  remoteType: unknown
): CandidatePathType {
  const local = normalizeCandidateType(localType)
  const remote = normalizeCandidateType(remoteType)
  if (!local || !remote) return 'unknown'
  if (local === 'relay' || remote === 'relay') return 'relay'
  if (local === 'srflx' || remote === 'srflx' || local === 'prflx' || remote === 'prflx') return 'srflx'
  if (local === 'host' && remote === 'host') return 'host'
  return 'unknown'
}

function statsValues(stats: StatsReportLike): StatsRecord[] {
  const values: StatsRecord[] = []
  stats.forEach((value) => values.push(value))
  return values
}

function statsGet(stats: StatsReportLike, key: string | undefined): StatsRecord | undefined {
  if (!key) return undefined
  if ('get' in stats && typeof stats.get === 'function') {
    return stats.get(key)
  }
  return statsValues(stats).find((entry) => entry['id'] === key)
}

function findSelectedCandidatePair(stats: StatsReportLike): StatsRecord | undefined {
  const values = statsValues(stats)
  const transport = values.find((entry) =>
    entry['type'] === 'transport' && typeof entry['selectedCandidatePairId'] === 'string'
  )
  const pairFromTransport = statsGet(stats, asString(transport?.['selectedCandidatePairId']))
  if (pairFromTransport) return pairFromTransport

  return values.find((entry) =>
    entry['type'] === 'candidate-pair' &&
    (entry['selected'] === true || entry['nominated'] === true || entry['state'] === 'succeeded')
  )
}

export function extractPeerTelemetryFromStats(input: TelemetryExtractInput): PeerTelemetrySample {
  const pair = findSelectedCandidatePair(input.stats)
  const localCandidate = statsGet(input.stats, asString(pair?.['localCandidateId']))
  const remoteCandidate = statsGet(input.stats, asString(pair?.['remoteCandidateId']))
  const localCandidateType = candidateTypeFromPair(
    localCandidate?.['candidateType'],
    localCandidate?.['candidateType']
  )
  const remoteCandidateType = candidateTypeFromPair(
    remoteCandidate?.['candidateType'],
    remoteCandidate?.['candidateType']
  )
  const rttSeconds = asNumber(pair?.['currentRoundTripTime'])
  const bytesSent = asNumber(pair?.['bytesSent'])
  const bytesReceived = asNumber(pair?.['bytesReceived'])

  return {
    schema_version: 1,
    type: 'webrtc-edge',
    room_id: input.roomId,
    topology_label: input.topologyLabel ?? 'loopback',
    node_id: input.nodeId,
    peer_id: input.peerId,
    role: input.role,
    selected_candidate_type: candidateTypeFromPair(
      localCandidate?.['candidateType'],
      remoteCandidate?.['candidateType']
    ),
    ...(localCandidateType !== 'unknown' ? { local_candidate_type: localCandidateType } : {}),
    ...(remoteCandidateType !== 'unknown' ? { remote_candidate_type: remoteCandidateType } : {}),
    ice_connection_state: input.iceConnectionState,
    connection_state: input.connectionState,
    data_channel_state: input.dataChannelState,
    ...(rttSeconds !== undefined ? { current_round_trip_time_ms: Math.round(rttSeconds * 100000) / 100 } : {}),
    ...(bytesSent !== undefined ? { bytes_sent: bytesSent } : {}),
    ...(bytesReceived !== undefined ? { bytes_received: bytesReceived } : {}),
    timestamp: input.timestamp,
  }
}

async function samplePeerTelemetry(conn: PeerConnection): Promise<PeerTelemetrySample> {
  try {
    const stats = await conn.pc.getStats()
    const sample = extractPeerTelemetryFromStats({
      roomId,
      topologyLabel,
      nodeId: nodeId ?? 'unknown',
      peerId: conn.peerId,
      role: conn.role,
      connectionState: conn.pc.connectionState,
      iceConnectionState: conn.pc.iceConnectionState,
      dataChannelState: conn.cacheFetch.readyState,
      timestamp: Date.now(),
      stats,
    })
    telemetrySamples.push(sample)
    return sample
  } catch {
    const sample: PeerTelemetrySample = {
      schema_version: 1,
      type: 'webrtc-edge',
      room_id: roomId,
      topology_label: topologyLabel,
      node_id: nodeId ?? 'unknown',
      peer_id: conn.peerId,
      role: conn.role,
      selected_candidate_type: 'unknown',
      ice_connection_state: conn.pc.iceConnectionState,
      connection_state: conn.pc.connectionState,
      data_channel_state: conn.cacheFetch.readyState,
      timestamp: Date.now(),
    }
    telemetrySamples.push(sample)
    return sample
  }
}

export async function collectPeerTelemetry(): Promise<PeerTelemetrySample[]> {
  const liveSamples = await Promise.all(
    [...connections.values()].map((conn) => samplePeerTelemetry(conn))
  )
  return liveSamples.length > 0 ? liveSamples : [...telemetrySamples]
}

export function getPeerTelemetrySamples(): PeerTelemetrySample[] {
  return [...telemetrySamples]
}

export function buildStoragePressureSample(input: StoragePressureInput): StoragePressureSample {
  const usage = typeof input.usage === 'number' && Number.isFinite(input.usage) ? input.usage : null
  const quota = typeof input.quota === 'number' && Number.isFinite(input.quota) ? input.quota : null
  const ratio = usage !== null && quota !== null && quota > 0
    ? Math.max(0, Math.min(1, Math.round((usage / quota) * 10000) / 10000))
    : null

  return {
    schema_version: 1,
    type: 'storage-pressure',
    room_id: input.roomId,
    topology_label: input.topologyLabel,
    node_id: input.nodeId,
    usage_bytes: usage,
    quota_bytes: quota,
    usage_ratio: ratio,
    timestamp: input.timestamp,
  }
}

export async function collectStoragePressure(): Promise<StoragePressureSample> {
  let estimate: StorageEstimate = {}
  try {
    estimate = await navigator.storage?.estimate?.() ?? {}
  } catch {
    estimate = {}
  }

  return buildStoragePressureSample({
    roomId,
    topologyLabel,
    nodeId: nodeId ?? 'unknown',
    usage: estimate.usage,
    quota: estimate.quota,
    timestamp: Date.now(),
  })
}

// ---------------------------------------------------------------------------
// getNodeIdFromSW — request the SW node ID via GET_NODE_ID postMessage
// ---------------------------------------------------------------------------

async function getNodeIdFromSW(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const channel = new MessageChannel()
    const timeout = setTimeout(
      () => reject(new Error('[p2p] GET_NODE_ID timeout')),
      2000
    )

    // port2 is transferred to SW; port1 stays here to receive the reply
    channel.port1.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'NODE_ID' && event.data.nodeId) {
        clearTimeout(timeout)
        resolve(event.data.nodeId as string)
      }
    }

    if (!navigator.serviceWorker.controller) {
      clearTimeout(timeout)
      reject(new Error('[p2p] no SW controller'))
      return
    }

    navigator.serviceWorker.controller.postMessage(
      { type: 'GET_NODE_ID' },
      [channel.port2]
    )
  })
}

// ---------------------------------------------------------------------------
// connectToPeer — create RTCPeerConnection + channels, attach all event handlers
// ---------------------------------------------------------------------------

function getRoomId(): string {
  if (typeof window === 'undefined') return DEFAULT_SIGNALING_ROOM

  const globalRoom = (window as unknown as Record<string, unknown>)['__nodexRoomId']
  if (typeof globalRoom === 'string' && globalRoom.trim().length > 0) {
    return globalRoom.trim()
  }

  const params = new URLSearchParams(window.location.search)
  return params.get('nodexRoom')?.trim() || params.get('room')?.trim() || DEFAULT_SIGNALING_ROOM
}

function getTopologyLabel(): string {
  if (typeof window === 'undefined') return 'loopback'

  const globalLabel = (window as unknown as Record<string, unknown>)['__nodexTopologyLabel']
  if (typeof globalLabel === 'string' && globalLabel.trim().length > 0) {
    return globalLabel.trim()
  }

  const params = new URLSearchParams(window.location.search)
  return params.get('nodexTopology')?.trim() || 'loopback'
}

function getRuntimeConfigFromPage(): NodexRuntimeConfig {
  if (typeof window === 'undefined') return resolveNodexRuntimeConfig()
  const params = new URLSearchParams(window.location.search)
  return resolveNodexRuntimeConfig({
    signalingUrl: params.get('nodexSignalingUrl') ?? params.get('signalingUrl') ?? undefined,
    iceServersJson: params.get('nodexIceServers') ?? undefined,
    forceRelay: params.get('nodexForceRelay') ?? undefined,
    appOrigin: params.get('nodexAppOrigin') ?? undefined,
    apiOrigin: params.get('nodexApiOrigin') ?? undefined,
    apiToken: params.get('nodexBetaToken') ?? undefined,
  })
}

async function fetchTurnCredentials(apiOrigin: string, token: string): Promise<void> {
  if (!token) return
  try {
    const res = await fetch(`${apiOrigin}/api/turn-credentials`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      console.warn('[p2p] TURN credentials fetch failed:', res.status)
      return
    }
    const body = await res.json() as { iceServers?: unknown; expiresAt?: number }
    if (Array.isArray(body.iceServers) && body.iceServers.length > 0) {
      runtimeConfig = resolveNodexRuntimeConfig({
        ...runtimeConfig,
        iceServers: body.iceServers as IceServerConfig[],
        apiToken: token,
      })
      turnCredentialExpiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : 0
    }
  } catch (err) {
    console.warn('[p2p] TURN credentials fetch error:', err)
  }
}

async function importSessionKeyFromServer(apiOrigin: string, token: string): Promise<void> {
  if (!token) return
  try {
    const res = await fetch(`${apiOrigin}/api/session-key`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      console.warn('[p2p] session key fetch failed:', res.status)
      return
    }
    const body = await res.json() as { keyId?: string; keyBytes?: string }
    if (body.keyBytes && body.keyId && navigator.serviceWorker.controller) {
      const raw = Uint8Array.from(atob(body.keyBytes), (c) => c.charCodeAt(0))
      navigator.serviceWorker.controller.postMessage({
        type: 'IMPORT_SESSION_KEY',
        keyId: body.keyId,
        keyBytes: raw,
      }, [raw.buffer])
    }
  } catch (err) {
    console.warn('[p2p] session key import error:', err)
  }
}

function getSignalingUrl(room: string): string {
  return buildSignalingUrl(room, (runtimeConfig ?? resolveNodexRuntimeConfig()).signalingUrl)
}

function getHttpSignalingBase(): string | null {
  const configured = (runtimeConfig ?? resolveNodexRuntimeConfig()).signalingUrl
  if (!configured.startsWith('http://') && !configured.startsWith('https://')) return null
  return configured.replace(/\/$/, '')
}

async function postHttpSignal(baseUrl: string, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

async function startHttpSignaling(baseUrl: string, currentRoomId: string, currentNodeId: string): Promise<void> {
  signalingAbortController?.abort()
  signalingAbortController = new AbortController()
  const signal = signalingAbortController.signal

  const joinRes = await postHttpSignal(baseUrl, '/join', { roomId: currentRoomId, nodeId: currentNodeId }, signal)
  if (!joinRes.ok) throw new Error(`[p2p] HTTP signaling join failed: ${joinRes.status}`)
  const join = await joinRes.json() as { peers?: string[]; polite?: boolean; after?: number }

  signalingTransport = {
    send(payload: string) {
      let message: SignalingMessage
      try {
        message = JSON.parse(payload) as SignalingMessage
      } catch {
        return
      }
      void postHttpSignal(baseUrl, '/send', { roomId: currentRoomId, message }, signal).catch((err) => {
        if (!signal.aborted) console.warn('[p2p] HTTP signaling send failed:', err)
      })
    },
    close() {
      signalingAbortController?.abort()
      if (signalingPollTimer !== null) window.clearInterval(signalingPollTimer)
      signalingPollTimer = null
      signalingAbortController = null
      signalingTransport = null
      void postHttpSignal(baseUrl, '/leave', { roomId: currentRoomId, nodeId: currentNodeId }).catch(() => undefined)
    },
  }

  await handleSignalingMessage({
    type: 'JOIN_ACK',
    from: 'server',
    peers: join.peers ?? [],
    polite: Boolean(join.polite),
  })

  let after = Number.isFinite(join.after) ? Number(join.after) : 0
  signalingPollTimer = window.setInterval(() => {
    if (!signalingTransport || signal.aborted) return
    const url = new URL(`${baseUrl}/poll`)
    url.searchParams.set('roomId', currentRoomId)
    url.searchParams.set('nodeId', currentNodeId)
    url.searchParams.set('after', String(after))
    fetch(url, { signal })
      .then((res) => res.ok ? res.json() : null)
      .then((body: { messages?: Array<{ id: number; message: SignalingMessage | GossipMessage }> } | null) => {
        for (const envelope of body?.messages ?? []) {
          if (Number.isFinite(envelope.id)) after = Math.max(after, envelope.id)
          void handleSignalingMessage(envelope.message).catch((err) => {
            console.warn('[p2p] HTTP signaling message error:', err)
          })
        }
      })
      .catch((err) => {
        if (!signal.aborted) console.warn('[p2p] HTTP signaling poll failed:', err)
      })
  }, 500)
}

function connectToPeer(peerId: string, polite: boolean, role: PeerRole = 'local'): void {
  if (connections.has(peerId)) return

  const token = (runtimeConfig ?? resolveNodexRuntimeConfig()).apiToken
  const apiOrigin = (runtimeConfig ?? resolveNodexRuntimeConfig()).apiOrigin
  if (token && turnCredentialExpiresAt > 0 && Date.now() > turnCredentialExpiresAt - 5 * 60 * 1000) {
    void fetchTurnCredentials(apiOrigin, token)
  }

  const config = runtimeConfig ?? resolveNodexRuntimeConfig()
  const pc = new RTCPeerConnection({
    iceServers: config.iceServers,
    iceTransportPolicy: config.iceTransportPolicy,
  })
  const { gossip, cacheFetch } = createChannels(pc)

  const conn: PeerConnection = {
    peerId,
    pc,
    gossip,
    cacheFetch,
    polite,
    role,
    state: 'connecting',
    makingOffer: false,
    ignoreOffer: false,
  }
  connections.set(peerId, conn)
  gossipEngine.attachChannel(peerId, gossip)

  const recordTelemetry = () => {
    void samplePeerTelemetry(conn)
  }

  gossip.addEventListener('open', recordTelemetry)
  gossip.addEventListener('close', recordTelemetry)
  cacheFetch.addEventListener('open', recordTelemetry)
  cacheFetch.addEventListener('close', recordTelemetry)

  // Perfect Negotiation: offer creation
  pc.onnegotiationneeded = async () => {
    try {
      conn.makingOffer = true
      await pc.setLocalDescription()
      signalingTransport?.send(
        JSON.stringify({
          type: 'OFFER',
          sdp: pc.localDescription,
          from: nodeId,
          to: peerId,
        })
      )
    } catch (err) {
      console.warn('[p2p] onnegotiationneeded error:', err)
    } finally {
      conn.makingOffer = false
    }
  }

  // ICE candidate relay
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && signalingTransport) {
      signalingTransport.send(
        JSON.stringify({
          type: 'ICE_CANDIDATE',
          candidate,
          from: nodeId,
          to: peerId,
        })
      )
    }
  }

  // Connection state machine + ICE restart on failure (PEER-04)
  pc.addEventListener('connectionstatechange', () => {
    const state = pc.connectionState
    if (state === 'connected') {
      conn.state = 'connected'
      console.log(`[P2P] connected to ${peerId}`)
    } else if (state === 'failed') {
      conn.state = 'failed'
      console.log('[P2P] connection failed, triggering ICE restart')
      // Reject only pending requests that were sent to this peer (WR-04)
      for (const [reqId, { resolver, peerId: rPeerId }] of pendingRequests) {
        if (rPeerId === peerId) {
          resolver({ type: 'CACHE_FETCH_RESPONSE', reqId, found: false })
          pendingRequests.delete(reqId)
        }
      }
      pc.restartIce()
    } else if (state === 'closed') {
      conn.state = 'closed'
      connections.delete(peerId)
    }
    recordTelemetry()
  })

  pc.addEventListener('iceconnectionstatechange', () => {
    recordTelemetry()
  })

  // Dispatch cache-fetch DataChannel messages — handles both response and inbound request paths
  cacheFetch.onmessage = (event: MessageEvent) => {
    let data: PeerFetchResponse | PeerFetchRequest
    try {
      data = JSON.parse(event.data as string) as typeof data
    } catch {
      return
    }
    if ((data as PeerFetchResponse).type === 'CACHE_FETCH_RESPONSE') {
      // Existing path — dispatch to pendingRequests resolver
      const resp = data as PeerFetchResponse
      if (resp.found && resp.payload) {
        try {
          const parsed = JSON.parse(resp.payload) as { ciphertext?: string; iv?: string; seq?: number; key?: string }
          lastP2PCapture = {
            key: parsed.key ?? 'unknown',
            seq: parsed.seq ?? 0,
            ivB64: parsed.iv,
            ctSample: parsed.ciphertext?.slice(0, 64),
            ts: Date.now(),
          }
          ;(window as unknown as Record<string, unknown>)['__nodexLastP2PCapture'] = () => lastP2PCapture
        } catch { /* non-JSON payload — skip capture */ }
      }
      const entry = pendingRequests.get(resp.reqId)
      if (entry) {
        entry.resolver(resp)
        pendingRequests.delete(resp.reqId)
      }
    } else if ((data as PeerFetchRequest).type === 'CACHE_FETCH_REQUEST') {
      // Serve path — forward inbound peer request to SW via P2P_FETCH_SERVE (VOL-05 D-10)
      const req = data as PeerFetchRequest
      if (!req.reqId || !req.key) return
      askSwToServe(req.key)
        .then((result) => {
          const response: PeerFetchResponse = {
            type: 'CACHE_FETCH_RESPONSE',
            reqId: req.reqId,
            found: result.found,
            payload: result.payload,
            seq: result.seq,
          }
          try { conn.cacheFetch.send(JSON.stringify(response)) } catch { /* DC may be closing */ }
        })
        .catch(() => {
          try {
            conn.cacheFetch.send(JSON.stringify({ type: 'CACHE_FETCH_RESPONSE', reqId: req.reqId, found: false }))
          } catch { /* DC may be closing */ }
        })
    }
  }
}

// ---------------------------------------------------------------------------
// askSwToServe — bridge to SW via P2P_FETCH_SERVE + MessageChannel (T-04-05)
// ---------------------------------------------------------------------------

function askSwToServe(key: string): Promise<{ found: boolean; payload?: string; seq?: number }> {
  return new Promise((resolve) => {
    const controller = navigator.serviceWorker.controller
    if (!controller) {
      resolve({ found: false })
      return
    }
    const channel = new MessageChannel()
    // T-04-05: 1000ms timeout — serving node never blocks requesting peer indefinitely
    const timeout = setTimeout(() => resolve({ found: false }), 1000)
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timeout)
      const data = event.data as { found: boolean; payload?: string; seq?: number }
      resolve({ found: data.found, payload: data.payload, seq: data.seq })
    }
    controller.postMessage({ type: 'P2P_FETCH_SERVE', key }, [channel.port2])
  })
}

// ---------------------------------------------------------------------------
// sendCacheFetchRequest — send over cache-fetch DC, reply on SW MessagePort
// ---------------------------------------------------------------------------

function sendCacheFetchRequest(
  conn: PeerConnection,
  key: string,
  replyPort: MessagePort
): void {
  const reqId = crypto.randomUUID()

  pendingRequests.set(reqId, {
    peerId: conn.peerId,
    resolver: (response: PeerFetchResponse) => {
      replyPort.postMessage({
        type: 'P2P_FETCH_RESPONSE',
        found: response.found,
        payload: response.payload,
        seq: response.seq,
      })
    },
  })

  const request: PeerFetchRequest = { type: 'CACHE_FETCH_REQUEST', reqId, key }
  try {
    conn.cacheFetch.send(JSON.stringify(request))
  } catch (err) {
    console.warn('[p2p] sendCacheFetchRequest send error:', err)
    pendingRequests.delete(reqId)
    replyPort.postMessage({ type: 'P2P_FETCH_RESPONSE', found: false })
  }
}

// ---------------------------------------------------------------------------
// handleSwMessage — dispatches P2P_FETCH from the Service Worker
// ---------------------------------------------------------------------------

function handleSwMessage(event: MessageEvent): void {
  if (event.data?.type !== 'P2P_FETCH') return

  const key = event.data.key as string
  const replyPort = event.ports[0]
  if (!replyPort) return

  const peer = selectConnectedPeer()
  if (!peer) {
    replyPort.postMessage({ type: 'P2P_FETCH_RESPONSE', found: false })
    return
  }

  sendCacheFetchRequest(peer, key, replyPort)
}

// ---------------------------------------------------------------------------
// handleSignalingMessage — process incoming signaling WS messages
// ---------------------------------------------------------------------------

async function handleSignalingMessage(msg: SignalingMessage | GossipMessage): Promise<void> {
  // Server-seeded invalidations arrive via signaling WebSocket
  if (msg.type === 'GOSSIP_INVALIDATE') {
    gossipEngine.onmessage(msg as GossipMessage, 'server')
    return
  }
  if (msg.type === 'BROADCAST') {
    const bcast = msg as SignalingMessage
    if (bcast.key && typeof bcast.seq === 'number') {
      gossipEngine.sendInvalidation(bcast.key, bcast.seq, bcast.from ?? 'server')
    }
    return
  }

  const sigMsg = msg as SignalingMessage
  if (sigMsg.type === 'JOIN_ACK') {
    const peers = sigMsg.peers ?? []
    // peers[0..PEER_FANOUT-1] = local; peers[PEER_FANOUT..PEER_FANOUT+LONG_RANGE_PEER_COUNT-1] = long-range
    for (let i = 0; i < peers.length; i++) {
      const role: PeerRole = i < PEER_FANOUT ? 'local' : 'long-range'
      connectToPeer(peers[i], !!sigMsg.polite, role)
    }
    return
  }

  if (!sigMsg.from) return
  const from = sigMsg.from

  if (sigMsg.type === 'OFFER' || sigMsg.type === 'ANSWER') {
    if (!sigMsg.sdp) return

    // Accept inbound connections from peers we haven't seen yet (polite: true)
    if (!connections.has(from)) {
      connectToPeer(from, true)
    }
    const conn = connections.get(from)
    if (!conn) return

    const description = sigMsg.sdp as RTCSessionDescriptionInit
    const offerCollision =
      description.type === 'offer' &&
      (conn.makingOffer || conn.pc.signalingState !== 'stable')
    conn.ignoreOffer = !conn.polite && offerCollision
    if (conn.ignoreOffer) return

    try {
      await conn.pc.setRemoteDescription(description)
      if (description.type === 'offer') {
        await conn.pc.setLocalDescription()
        signalingTransport?.send(
          JSON.stringify({
            type: 'ANSWER',
            sdp: conn.pc.localDescription,
            from: nodeId,
            to: from,
          })
        )
      }
    } catch (err) {
      console.warn('[p2p] setRemoteDescription error:', err)
    }
  } else if (sigMsg.type === 'ICE_CANDIDATE') {
    if (!sigMsg.candidate) return
    const conn = connections.get(from)
    if (!conn) return
    try {
      await conn.pc.addIceCandidate(sigMsg.candidate as RTCIceCandidateInit)
    } catch (err) {
      if (!conn.ignoreOffer) {
        console.warn('[p2p] addIceCandidate error:', err)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// init — idempotent: if signaling transport already exists, returns immediately
// ---------------------------------------------------------------------------

function exposeLeadershipState(): void {
  if (typeof window === 'undefined') return
  const isLeader = leadershipRole === 'leader'
  ;(window as unknown as Record<string, unknown>)['__nodexP2PLeadership'] = () => ({
    tabId,
    role: leadershipRole,
    isLeader,
    roomId,
  })
  ;(window as unknown as Record<string, unknown>)['__nodexP2PLeader'] = isLeader
}

function readLeaderLock(): { tabId: string; expiresAt: number } | null {
  try {
    const raw = localStorage.getItem(LEADER_LOCK_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { tabId?: unknown; expiresAt?: unknown }
    if (typeof parsed.tabId !== 'string' || typeof parsed.expiresAt !== 'number') return null
    return { tabId: parsed.tabId, expiresAt: parsed.expiresAt }
  } catch {
    return null
  }
}

function writeLeaderLock(): void {
  localStorage.setItem(LEADER_LOCK_KEY, JSON.stringify({
    tabId,
    expiresAt: Date.now() + LEADER_LEASE_MS,
  }))
}

function tryAcquireLeadership(): boolean {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return true

  try {
    const existing = readLeaderLock()
    if (!existing || existing.tabId === tabId || existing.expiresAt <= Date.now()) {
      writeLeaderLock()
      leadershipRole = 'leader'
      exposeLeadershipState()
      return true
    }
    leadershipRole = 'follower'
    exposeLeadershipState()
    return false
  } catch {
    leadershipRole = 'leader'
    exposeLeadershipState()
    return true
  }
}

function startLeaderRenewal(): void {
  if (typeof window === 'undefined') return
  if (leaderRenewTimer !== null) window.clearInterval(leaderRenewTimer)
  leaderRenewTimer = window.setInterval(() => {
    if (leadershipRole === 'leader') {
      try { writeLeaderLock() } catch { /* best-effort */ }
    }
  }, LEADER_RENEW_MS)
}

function releaseLeadership(): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return
  try {
    const existing = readLeaderLock()
    if (existing?.tabId === tabId) {
      localStorage.removeItem(LEADER_LOCK_KEY)
    }
  } catch {
    // best-effort
  }
}

function markPeerManagerReady(): void {
  if (typeof window === 'undefined') return
  const config = runtimeConfig ?? resolveNodexRuntimeConfig()
  ;(window as unknown as Record<string, unknown>)['__peerManager'] = peerManager
  ;(window as unknown as Record<string, unknown>)['__peerConnections'] = connections
  ;(window as unknown as Record<string, unknown>)['__gossipEngine'] = gossipEngine
  ;(window as unknown as Record<string, unknown>)['__peerManagerReady'] = true
  ;(window as unknown as Record<string, unknown>)['__nodeId'] = nodeId
  ;(window as unknown as Record<string, unknown>)['__nodexRoomId'] = roomId
  ;(window as unknown as Record<string, unknown>)['__nodexTopologyLabel'] = topologyLabel
  ;(window as unknown as Record<string, unknown>)['__nodexPeerTelemetry'] = collectPeerTelemetry
  ;(window as unknown as Record<string, unknown>)['__nodexPeerTelemetrySamples'] = getPeerTelemetrySamples
  ;(window as unknown as Record<string, unknown>)['__nodexStoragePressure'] = collectStoragePressure
  ;(window as unknown as Record<string, unknown>)['__nodexRuntimeConfig'] = () => ({
    appOrigin: config.appOrigin,
    apiOrigin: config.apiOrigin,
    signalingUrl: config.signalingUrl,
    forceRelay: config.forceRelay,
    iceTransportPolicy: config.iceTransportPolicy,
    iceServerCount: config.iceServers.length,
  })
  ;(window as unknown as Record<string, unknown>)['__nodexLastP2PCapture'] = () => lastP2PCapture
  exposeLeadershipState()
}

function startFollowerRetryLoop(): void {
  if (typeof window === 'undefined' || followerRetryTimer !== null) return
  followerRetryTimer = window.setInterval(() => {
    if (signalingTransport !== null || sessionStartInProgress) return
    if (tryAcquireLeadership()) {
      window.clearInterval(followerRetryTimer!)
      followerRetryTimer = null
      void startP2PSession()
    }
  }, LEADER_RENEW_MS)
}

async function startP2PSession(): Promise<void> {
  if (signalingTransport !== null || sessionStartInProgress) return
  sessionStartInProgress = true
  roomId = getRoomId()
  topologyLabel = getTopologyLabel()
  runtimeConfig = getRuntimeConfigFromPage()

  try {
    nodeId = await getNodeIdFromSW()
  } catch (err) {
    console.warn('[p2p] failed to get nodeId from SW:', err)
    sessionStartInProgress = false
    return
  }

  // Fetch session key and post to SW for AES-GCM decryption (CRPT-02)
  try {
    const keyRes = await fetch('/api/session-key')
    if (keyRes.ok) {
      const { keyId, keyBytes } = await keyRes.json() as { keyId: string; keyBytes: string }
      navigator.serviceWorker.controller?.postMessage({ type: 'IMPORT_SESSION_KEY', keyId, keyBytes })
    }
  } catch (err) {
    console.warn('[p2p] session key fetch failed:', err)
  }

  const httpSignalingBase = getHttpSignalingBase()
  if (httpSignalingBase) {
    try {
      await startHttpSignaling(httpSignalingBase, roomId, nodeId)
    } catch (err) {
      console.warn('[p2p] HTTP signaling error:', err)
      signalingTransport = null
    }
  } else {
    const ws = new WebSocket(getSignalingUrl(roomId))
    signalingTransport = {
      send(payload: string) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload)
      },
      close() {
        ws.close()
      },
    }

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'JOIN', from: nodeId }))
      markPeerManagerReady()
    })

    ws.addEventListener('message', (event) => {
      let msg: SignalingMessage | GossipMessage
      try {
        msg = JSON.parse(event.data as string) as SignalingMessage | GossipMessage
      } catch {
        return
      }
      handleSignalingMessage(msg).catch((err) => {
        console.warn('[p2p] handleSignalingMessage error:', err)
      })
    })

    ws.addEventListener('close', () => {
      signalingTransport = null
    })

    ws.addEventListener('error', (err) => {
      console.warn('[p2p] WebSocket error:', err)
      signalingTransport = null
    })
  }

  // Register SW message handler for P2P_FETCH requests
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', handleSwMessage)
  }

  markPeerManagerReady()
  sessionStartInProgress = false
}

async function init(): Promise<void> {
  if (signalingTransport !== null || sessionStartInProgress) return
  roomId = getRoomId()
  topologyLabel = getTopologyLabel()
  runtimeConfig = getRuntimeConfigFromPage()

  const token = runtimeConfig.apiToken
  const apiOrigin = runtimeConfig.apiOrigin
  if (token) {
    await Promise.all([
      fetchTurnCredentials(apiOrigin, token),
      importSessionKeyFromServer(apiOrigin, token),
    ])
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', releaseLeadership, { once: true })
  }

  if (!tryAcquireLeadership()) {
    markPeerManagerReady()
    startFollowerRetryLoop()
    return
  }

  startLeaderRenewal()
  await startP2PSession()
}

// ---------------------------------------------------------------------------
// _resetForTest — clears all module state for vitest test isolation
// ---------------------------------------------------------------------------

export function _resetForTest(): void {
  connections.clear()
  pendingRequests.clear()
  signalingTransport = null
  if (signalingPollTimer !== null && typeof window !== 'undefined') {
    window.clearInterval(signalingPollTimer)
  }
  signalingPollTimer = null
  signalingAbortController?.abort()
  signalingAbortController = null
  nodeId = null
  roomId = DEFAULT_SIGNALING_ROOM
  topologyLabel = 'loopback'
  runtimeConfig = null
  sessionStartInProgress = false
  leadershipRole = 'unknown'
  telemetrySamples.length = 0
  leaderRenewTimer = null
  followerRetryTimer = null
  lastP2PCapture = null
  _resetGossipForTest()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const peerManager = {
  init,
  collectTelemetry: collectPeerTelemetry,
  collectStoragePressure,
  getTelemetrySamples: getPeerTelemetrySamples,
}
