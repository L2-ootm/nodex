// src/p2p/p2p-manager.ts
// Page-side P2P Manager: RTCPeerConnection pool, DataChannels, ICE restart, postMessage bridge.
// RTCPeerConnection is unavailable in SW scope — this module runs on the page only.

import {
  SIGNALING_URL,
  PEER_FANOUT,
  LONG_RANGE_PEER_COUNT,
  ICE_SERVERS,
  DC_GOSSIP_ID,
  DC_CACHE_FETCH_ID,
  METRICS_CHANNEL_NAME,
} from '../shared/config.js'
import type { SignalingMessage, PeerFetchRequest, PeerFetchResponse } from '../shared/types.js'
import { GossipEngine, _resetForTest as _resetGossipForTest } from '../gossip/gossip-engine.js'

// Per-connection state model (includes Perfect Negotiation flags)
interface PeerConnection {
  peerId: string
  pc: RTCPeerConnection
  gossip: RTCDataChannel
  cacheFetch: RTCDataChannel
  polite: boolean
  role: 'local' | 'long-range'
  state: 'connecting' | 'connected' | 'failed' | 'closed'
  makingOffer: boolean
  ignoreOffer: boolean
}

// Module-level state — exported for test introspection and _resetForTest
export const connections = new Map<string, PeerConnection>()
export const pendingRequests = new Map<string, (response: PeerFetchResponse) => void>()
let signalingWs: WebSocket | null = null
let nodeId: string | null = null

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

function connectToPeer(peerId: string, polite: boolean, role: 'local' | 'long-range' = 'local'): void {
  if (connections.has(peerId)) return

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
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

  // Perfect Negotiation: offer creation
  pc.onnegotiationneeded = async () => {
    try {
      conn.makingOffer = true
      await pc.setLocalDescription()
      signalingWs?.send(
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
    if (candidate && signalingWs) {
      signalingWs.send(
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
      // Reject all pending requests for this peer gracefully
      for (const [reqId, resolver] of pendingRequests) {
        resolver({ type: 'CACHE_FETCH_RESPONSE', reqId, found: false })
        pendingRequests.delete(reqId)
      }
      pc.restartIce()
    } else if (state === 'closed') {
      conn.state = 'closed'
      connections.delete(peerId)
    }
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
      const resolver = pendingRequests.get(resp.reqId)
      if (resolver) {
        resolver(resp)
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

  pendingRequests.set(reqId, (response: PeerFetchResponse) => {
    replyPort.postMessage({
      type: 'P2P_FETCH_RESPONSE',
      found: response.found,
      payload: response.payload,
      seq: response.seq,
    })
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

async function handleSignalingMessage(msg: SignalingMessage): Promise<void> {
  if (msg.type === 'JOIN_ACK') {
    const peers = msg.peers ?? []
    // peers[0..PEER_FANOUT-1] = local; peers[PEER_FANOUT..PEER_FANOUT+LONG_RANGE_PEER_COUNT-1] = long-range
    for (let i = 0; i < peers.length; i++) {
      const role: 'local' | 'long-range' = i < PEER_FANOUT ? 'local' : 'long-range'
      connectToPeer(peers[i], !!msg.polite, role)
    }
    return
  }

  if (!msg.from) return
  const from = msg.from

  if (msg.type === 'OFFER' || msg.type === 'ANSWER') {
    if (!msg.sdp) return

    // Accept inbound connections from peers we haven't seen yet (polite: true)
    if (!connections.has(from)) {
      connectToPeer(from, true)
    }
    const conn = connections.get(from)
    if (!conn) return

    const description = msg.sdp as RTCSessionDescriptionInit
    const offerCollision =
      description.type === 'offer' &&
      (conn.makingOffer || conn.pc.signalingState !== 'stable')
    conn.ignoreOffer = !conn.polite && offerCollision
    if (conn.ignoreOffer) return

    try {
      await conn.pc.setRemoteDescription(description)
      if (description.type === 'offer') {
        await conn.pc.setLocalDescription()
        signalingWs?.send(
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
  } else if (msg.type === 'ICE_CANDIDATE') {
    if (!msg.candidate) return
    const conn = connections.get(from)
    if (!conn) return
    try {
      await conn.pc.addIceCandidate(msg.candidate as RTCIceCandidateInit)
    } catch (err) {
      if (!conn.ignoreOffer) {
        console.warn('[p2p] addIceCandidate error:', err)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// init — idempotent: if signalingWs already set, returns immediately
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  if (signalingWs !== null) return

  try {
    nodeId = await getNodeIdFromSW()
  } catch (err) {
    console.warn('[p2p] failed to get nodeId from SW:', err)
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

  const ws = new WebSocket(SIGNALING_URL)
  signalingWs = ws

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'JOIN', from: nodeId }))
  })

  ws.addEventListener('message', (event) => {
    let msg: SignalingMessage
    try {
      msg = JSON.parse(event.data as string) as SignalingMessage
    } catch {
      return
    }
    handleSignalingMessage(msg).catch((err) => {
      console.warn('[p2p] handleSignalingMessage error:', err)
    })
  })

  ws.addEventListener('close', () => {
    signalingWs = null
  })

  ws.addEventListener('error', (err) => {
    console.warn('[p2p] WebSocket error:', err)
    signalingWs = null
  })

  // Register SW message handler for P2P_FETCH requests
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', handleSwMessage)
  }

  // Expose on window for Playwright test introspection (PEER-02, PEER-03, PEER-05, GOSP-06)
  if (typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>)['__peerManager'] = peerManager
    ;(window as unknown as Record<string, unknown>)['__peerConnections'] = connections
    ;(window as unknown as Record<string, unknown>)['__gossipEngine'] = gossipEngine
    ;(window as unknown as Record<string, unknown>)['__peerManagerReady'] = true
  }
}

// ---------------------------------------------------------------------------
// _resetForTest — clears all module state for vitest test isolation
// ---------------------------------------------------------------------------

export function _resetForTest(): void {
  connections.clear()
  pendingRequests.clear()
  signalingWs = null
  nodeId = null
  _resetGossipForTest()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const peerManager = { init }
