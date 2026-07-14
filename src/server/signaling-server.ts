// src/server/signaling-server.ts
// Hono + @hono/node-ws signaling server for Phase 2 WebRTC peer discovery
// Relays OFFER/ANSWER/ICE_CANDIDATE between peers; never relays data after handshake
//
// POC ONLY — production rewrite target: Go or Rust (see STATE.md stack constraints)

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import type { WSContext } from 'hono/ws'
import { createHash, timingSafeEqual } from 'node:crypto'
import { DEFAULT_SIGNALING_ROOM, SIGNALING_PORT, PEER_FANOUT, LONG_RANGE_PEER_COUNT } from '../shared/config.js'
import type { SignalingMessage } from '../shared/types.js'
import { assertSequenceResourceKey, assertSequenceUuid } from './sequence-authority.js'

const app = new Hono()
app.use('*', cors({ origin: '*' }))
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

// roomId → (nodeId → WSContext). The exported `peers` map is the default room
// for backwards-compatible tests and simple local development.
export const rooms = new Map<string, Map<string, WSContext>>()

export function getPeers(roomId = DEFAULT_SIGNALING_ROOM): Map<string, WSContext> {
  const normalizedRoom = roomId.trim() || DEFAULT_SIGNALING_ROOM
  let room = rooms.get(normalizedRoom)
  if (!room) {
    room = new Map<string, WSContext>()
    rooms.set(normalizedRoom, room)
  }
  return room
}

export const peers = getPeers(DEFAULT_SIGNALING_ROOM)

// nodeId lookup by WSContext (for onClose)
const wsToNode = new Map<WSContext, { nodeId: string; roomId: string }>()

function pruneRoomIfEmpty(roomId: string, room: Map<string, WSContext>): void {
  if (roomId !== DEFAULT_SIGNALING_ROOM && room.size === 0) {
    rooms.delete(roomId)
  }
}

app.get('/ws', upgradeWebSocket((c) => {
  const roomId = c.req.query('room')?.trim() || DEFAULT_SIGNALING_ROOM
  const roomPeers = getPeers(roomId)
  let nodeId: string | null = null

  return {
    onMessage(event, ws) {
      let msg: SignalingMessage
      try {
        msg = JSON.parse(event.data as string) as SignalingMessage
      } catch {
        return
      }

      if (!msg.type) return

      switch (msg.type) {
        case 'JOIN': {
          if (!msg.from) return
          nodeId = msg.from
          roomPeers.set(nodeId, ws)
          wsToNode.set(ws, { nodeId, roomId })

          // Select up to PEER_FANOUT most-recently-joined existing peers
          const existingIds: string[] = []
          for (const [id] of roomPeers) {
            if (id !== nodeId) existingIds.push(id)
          }
          const selected = existingIds.slice(-(PEER_FANOUT + LONG_RANGE_PEER_COUNT))

          // Reply with JOIN_ACK: polite=true if there are existing peers (joiner is responder)
          const ack: SignalingMessage = {
            type: 'JOIN_ACK',
            from: 'server',
            peers: selected,
            polite: selected.length > 0,
          }
          if (ws.readyState === 1 /* OPEN */) {
            ws.send(JSON.stringify(ack))
          }
          break
        }

        case 'OFFER':
        case 'ANSWER':
        case 'ICE_CANDIDATE': {
          if (!msg.to || !msg.from) return
          const target = roomPeers.get(msg.to)
          if (!target) return
          // Overwrite from with the registered nodeId (T-02-01 spoofing mitigation)
          const relay: SignalingMessage = { ...msg, from: nodeId ?? msg.from }
          if (target.readyState === WebSocket.OPEN) {
            target.send(JSON.stringify(relay))
          }
          break
        }

        case 'BROADCAST': {
          // Server-initiated gossip invalidation forwarded to all peers in room
          for (const [id, peer] of roomPeers) {
            if (id !== nodeId && peer.readyState === WebSocket.OPEN) {
              peer.send(JSON.stringify(msg))
            }
          }
          break
        }

        case 'LEAVE': {
          if (nodeId) {
            roomPeers.delete(nodeId)
            pruneRoomIfEmpty(roomId, roomPeers)
            wsToNode.delete(ws)
            nodeId = null
          }
          break
        }

        default:
          // Unknown types silently discarded (T-02-02)
          break
      }
    },

    onClose(_event, ws) {
      const entry = wsToNode.get(ws)
      if (entry) {
        const room = getPeers(entry.roomId)
        room.delete(entry.nodeId)
        pruneRoomIfEmpty(entry.roomId, room)
        wsToNode.delete(ws)
      }
    },
  }
}))

app.get('/health', (c) => {
  let totalPeers = 0
  for (const room of rooms.values()) totalPeers += room.size
  return c.json({ status: 'ok', rooms: rooms.size, peers: totalPeers })
})

// REST endpoint: seed a gossip invalidation into all connected peers across all rooms
app.post('/gossip-seed', async (c) => {
  const expectedToken = process.env['NODEX_SIGNALING_SEED_TOKEN']
  if (!expectedToken && process.env['NODE_ENV'] === 'production') {
    return c.json({ error: 'seed endpoint unavailable' }, 503)
  }
  if (expectedToken) {
    const supplied = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    const expectedHash = createHash('sha256').update(expectedToken).digest()
    const suppliedHash = createHash('sha256').update(supplied).digest()
    if (!timingSafeEqual(expectedHash, suppliedHash)) return c.json({ error: 'unauthorized' }, 401)
  }

  const expectedTenantId = process.env['NODEX_TENANT_ID']
  if (!expectedTenantId && process.env['NODE_ENV'] === 'production') {
    return c.json({ error: 'tenant boundary unavailable' }, 503)
  }

  let body: { tenantId?: string; key?: string; seq?: number; eventId?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  try {
    if (body.tenantId !== undefined) assertSequenceUuid(body.tenantId)
    assertSequenceResourceKey(body.key ?? '')
    if (body.eventId !== undefined) assertSequenceUuid(body.eventId)
  } catch {
    return c.json({ error: 'invalid invalidation event' }, 400)
  }
  if (expectedTenantId && body.tenantId !== expectedTenantId) {
    return c.json({ error: 'tenant mismatch' }, 403)
  }
  if (!Number.isSafeInteger(body.seq) || (body.seq as number) < 1) {
    return c.json({ error: 'invalid invalidation event' }, 400)
  }

  const msg: SignalingMessage = {
    type: 'BROADCAST',
    from: 'server',
    key: body.key,
    seq: body.seq,
    eventId: body.eventId,
  }
  const payload = JSON.stringify(msg)
  let notified = 0
  for (const room of rooms.values()) {
    for (const peer of room.values()) {
      if (peer.readyState === WebSocket.OPEN) { peer.send(payload); notified++ }
    }
  }
  return c.json({ seeded: true, notified })
})

if (process.env['NODE_ENV'] !== 'test') {
  const port = Number(process.env['PORT'] ?? SIGNALING_PORT)
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[Nodex Signaling] Listening on ws://localhost:${info.port}/ws`)
  })
  injectWebSocket(server)
}

export { app, injectWebSocket }
