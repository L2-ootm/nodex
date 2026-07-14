// src/gossip/gossip-engine.ts
// Gossip invalidation engine — pure TypeScript, no browser-only globals.
// emitMetric is injected as a DI callback to keep this module testable in Node.js.
// No broadcast or DOM-specific APIs are used — all side effects flow through DI callbacks.

import { GOSSIP_SEEN_SET_MAX, GOSSIP_TTL, PEER_FANOUT } from '../shared/config.js'
import type { GossipMessage, MetricsEvent } from '../shared/types.js'

// ---------------------------------------------------------------------------
// LruSet — bounded LRU deduplication set (T-03-01, GOSP-03)
// Evicts the oldest entry when size exceeds max. Re-inserting an existing key
// refreshes its LRU position (prevents premature eviction of active msgIds).
// ---------------------------------------------------------------------------

export class LruSet {
  private map = new Map<string, true>()
  private max: number

  constructor(max: number) {
    this.max = max
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  add(key: string): void {
    if (this.map.has(key)) {
      // LRU refresh: delete then re-insert moves key to most-recently-used position
      this.map.delete(key)
    }
    this.map.set(key, true)
    // Evict the oldest entry (first inserted) when over capacity
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string
      this.map.delete(oldest)
    }
  }
}

// ---------------------------------------------------------------------------
// Structural peer connection subset — avoids importing DOM-only RTCPeerConnection.
// GossipEngine only needs the gossip DataChannel and connection state.
// ---------------------------------------------------------------------------

interface GossipPeerEntry {
  gossip: RTCDataChannel
  state: string
}

// ---------------------------------------------------------------------------
// GossipEngine — epidemic gossip invalidation with seen-set dedup and seq guard
//
// Constructor parameters:
//   connections  — Map<peerId, { gossip: RTCDataChannel; state: string }>
//                  (structural subset of PeerConnection from p2p-manager.ts)
//   emitMetric   — DI callback; no channel import needed (injected from caller)
//   swNotify     — optional callback to notify the Service Worker of an
//                  invalidation BEFORE forwarding (called after seen-set and seq
//                  checks pass)
// ---------------------------------------------------------------------------

export class GossipEngine {
  private connections: Map<string, GossipPeerEntry>
  private emitMetric: (event: Partial<MetricsEvent> & { type: string }) => void
  private swNotify: ((msg: { key: string; seq: number }) => void) | undefined
  private seen = new LruSet(GOSSIP_SEEN_SET_MAX)
  private seqMap = new Map<string, number>()

  constructor(
    connections: Map<string, GossipPeerEntry>,
    emitMetric: (event: Partial<MetricsEvent> & { type: string }) => void,
    swNotify?: (msg: { key: string; seq: number }) => void,
  ) {
    this.connections = connections
    this.emitMetric = emitMetric
    this.swNotify = swNotify
  }

  // -------------------------------------------------------------------------
  // attachChannel — wire gossip.onmessage for a peer's DataChannel
  // -------------------------------------------------------------------------

  attachChannel(peerId: string, gossip: RTCDataChannel): void {
    gossip.onmessage = (event: MessageEvent) => {
      let msg: GossipMessage
      try {
        msg = JSON.parse(event.data as string) as GossipMessage
      } catch {
        return
      }
      this.onmessage(msg, peerId)
    }
  }

  // -------------------------------------------------------------------------
  // onmessage — core deduplication + seq guard + metric emit + forward
  // -------------------------------------------------------------------------

  onmessage(msg: GossipMessage, fromPeerId: string): void {
    // Validate required fields
    if (
      !msg.msgId ||
      typeof msg.seq !== 'number' ||
      msg.seq <= 0 ||
      !Number.isInteger(msg.seq) ||
      typeof msg.ttl !== 'number' ||
      msg.ttl < 0 ||
      !Number.isInteger(msg.ttl)
    ) {
      return
    }

    // T-03-01: duplicate drop — seen-set check
    if (this.seen.has(msg.msgId)) {
      return
    }
    this.seen.add(msg.msgId)

    // GOSP-04: seq monotonicity guard — drop stale or replayed invalidations
    if (this.seqMap.has(msg.key) && msg.seq <= this.seqMap.get(msg.key)!) {
      return
    }
    this.seqMap.set(msg.key, msg.seq)

    // Notify SW of the invalidation BEFORE forwarding
    this.swNotify?.({ key: msg.key, seq: msg.seq })

    // Emit gossip-propagation metric
    const now = Date.now()
    this.emitMetric({
      schema_version: 1,
      type: 'gossip-propagation',
      key: msg.key,
      msgId: msg.msgId,
      t_invalidate: msg.t_invalidate,
      t_received: now,
      hop_count: GOSSIP_TTL - msg.ttl,
      latency_ms: now - msg.t_invalidate,
      source_node_id: msg.originNodeId,
      timestamp: now,
    })

    // Forward if TTL allows further hops (T-03-02)
    if (msg.ttl > 0) {
      this.forward(msg, fromPeerId)
    }
  }

  // -------------------------------------------------------------------------
  // forward — Fisher-Yates shuffle + fanout forward to connected peers
  // -------------------------------------------------------------------------

  forward(msg: GossipMessage, excludePeerId: string): void {
    // Collect eligible connected peers (exclude the sender)
    const candidates: GossipPeerEntry[] = []
    for (const [peerId, conn] of this.connections) {
      if (conn.state === 'connected' && peerId !== excludePeerId) {
        candidates.push(conn)
      }
    }

    // Fisher-Yates in-place shuffle
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
    }

    // Select up to PEER_FANOUT peers and forward
    const targets = candidates.slice(0, PEER_FANOUT)
    const forwarded: GossipMessage = { ...msg, ttl: msg.ttl - 1 }
    const payload = JSON.stringify(forwarded)

    for (const conn of targets) {
      if (conn.gossip.readyState === 'open') {
        try {
          conn.gossip.send(payload)
        } catch (err) {
          console.warn('[gossip] forward send error:', err)
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // sendInvalidation — originate a new gossip invalidation from this node
  // -------------------------------------------------------------------------

  sendInvalidation(key: string, seq: number, originNodeId: string, msgId: string = crypto.randomUUID()): void {
    const msg: GossipMessage = {
      type: 'GOSSIP_INVALIDATE',
      msgId,
      key,
      seq,
      ttl: GOSSIP_TTL,
      originNodeId,
      t_invalidate: Date.now(),
    }
    // Route through onmessage so seen-set and dedup logic applies uniformly
    this.onmessage(msg, originNodeId)
  }
}

// ---------------------------------------------------------------------------
// _resetForTest — vitest isolation: call between tests to clear module-level
// state. GossipEngine instances own their own seen/seqMap, so this is a no-op
// for instance state — each test should construct a fresh GossipEngine.
// Exported so test files can call it as a guard.
// ---------------------------------------------------------------------------

export function _resetForTest(): void {
  // GossipEngine instances are created per-test; no module-level singleton state to clear.
  // This function exists as a stable contract for test files.
}
