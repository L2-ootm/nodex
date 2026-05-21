// src/server/signaling-server.ts
// Hono + @hono/node-ws signaling server for Phase 2 WebRTC peer discovery
// Port 3002 (separate from mock API on 3001)
// Relays OFFER/ANSWER/ICE_CANDIDATE between peers; never relays data after handshake
//
// POC ONLY — production rewrite target: Go or Rust (see STATE.md stack constraints)

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import type { WSContext } from 'hono/ws'
import { SIGNALING_PORT, PEER_FANOUT, LONG_RANGE_PEER_COUNT } from '../shared/config.js'
import type { SignalingMessage } from '../shared/types.js'

const app = new Hono()
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

// nodeId → WSContext — module-level, exported for test introspection
export const peers = new Map<string, WSContext>()

// nodeId lookup by WSContext (for onClose)
const wsToNodeId = new Map<WSContext, string>()

app.get('/ws', upgradeWebSocket((_c) => {
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
          peers.set(nodeId, ws)
          wsToNodeId.set(ws, nodeId)

          // Select up to PEER_FANOUT most-recently-joined existing peers
          const existingIds: string[] = []
          for (const [id] of peers) {
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
          const target = peers.get(msg.to)
          if (!target) return
          // Overwrite from with the registered nodeId (T-02-01 spoofing mitigation)
          const relay: SignalingMessage = { ...msg, from: nodeId ?? msg.from }
          if (target.readyState === WebSocket.OPEN) {
            target.send(JSON.stringify(relay))
          }
          break
        }

        case 'LEAVE': {
          if (nodeId) {
            peers.delete(nodeId)
            wsToNodeId.delete(ws)
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
      const id = wsToNodeId.get(ws)
      if (id) {
        peers.delete(id)
        wsToNodeId.delete(ws)
      }
    },
  }
}))

if (process.env['NODE_ENV'] !== 'test') {
  const server = serve({ fetch: app.fetch, port: SIGNALING_PORT }, (info) => {
    console.log(`[Nodex Signaling] Listening on ws://localhost:${info.port}/ws`)
  })
  injectWebSocket(server)
}

export { app, injectWebSocket }
