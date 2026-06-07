# Nodex Multi-Machine Test Plan

**Status:** ready for manual execution; hosted same-machine P2P smoke verified  
**Date:** 2026-05-27  
**Applies to:** Phase 7 external validity

## What Two Computers Can Prove

Two computers in the same city are useful.

They can validate:

- Same-LAN physical machine behavior.
- Same-city WAN/NAT behavior if each computer uses a different network.
- Real browser identity, Service Worker registration, WebRTC connection setup, and telemetry outside Playwright loopback.

They cannot validate:

- Geographic long-range / GOSP-06.
- Cross-region latency.
- Global routing behavior.

For GOSP-06, use two different cities, regions, or cloud regions.

## What The Hosted Smoke Already Proves

On 2026-05-27, `npm run verify:deployed-p2p` opened two isolated Chromium contexts against:

```text
https://nodex-beta.vercel.app/metrics.html
```

with:

```text
nodexSignalingUrl=https://nodex-beta-api.vercel.app/api/signal
```

The smoke produced:

```json
{
  "connectedPeers": { "nodeA": 1, "nodeB": 1 },
  "nodeBMetrics": { "peer-fetch": 1 }
}
```

This proves the deployed app can serve the protocol runtime, register the Service Worker, negotiate a WebRTC DataChannel through deployed signaling, and transfer cached encrypted data peer-to-peer between isolated browser nodes. It does not replace the physical machine matrix below.

## Minimum Test Matrix

| Test | Machines | Network | Verdict Scope |
|------|----------|---------|---------------|
| LAN | 2 | Same Wi-Fi/Ethernet | Proves physical same-LAN connectivity |
| Same-city NAT | 2 | Different ISPs/hotspots | Proves same-metro NAT traversal |
| TURN relay | 2 | Any, with real TURN | Proves relay fallback only if edge type is `relay` |
| Background tab | 1-2 | Any | Measures browser lifecycle behavior |
| Mobile | 1 desktop + 1 phone | Any | Measures mobile browser support |
| Geographic | 2+ | Different city/region/cloud region | Required for GOSP-06 |

## Host Commands

```powershell
npm install
npm run build
npm run server
npm run signaling
npx vite preview --host 0.0.0.0 --port 4173 --strictPort
```

Use separate terminals for `server`, `signaling`, and `vite preview`.

Open firewall ports `4173`, `3001`, and `3002`.

## Browser URL

```text
http://<host-ip>:4173/?nodexRoom=<room>&nodexTopology=<label>&nodexSignalingUrl=ws://<host-ip>:3002/ws
```

Example:

```text
http://192.168.1.25:4173/?nodexRoom=manual-lan-001&nodexTopology=lan-multi-machine&nodexSignalingUrl=ws://192.168.1.25:3002/ws
```

Hosted beta URL for field testers:

```text
https://nodex-beta.vercel.app/metrics.html?nodexRoom=<room>&nodexTopology=<label>&nodexSignalingUrl=https://nodex-beta-api.vercel.app/api/signal
```

The hosted route is useful for quick LAN/WAN checks because it removes local app/API setup from each tester. For controlled lab runs, the local host commands above still give you full control of the mock origin and WebSocket signaling server.

## Evidence Commands

Run in every browser console:

```js
await window.__nodexRuntimeConfig()
await window.__nodexPeerTelemetry()
await window.__nodexStoragePressure()
await window.__nodexP2PLeadership()
await fetch('/api/products/manual-lan-1').then((response) => response.status)
```

To explicitly check whether the latest browser produced P2P transfer events:

```js
const events = []
const channel = new BroadcastChannel('nodex-metrics')
channel.onmessage = (event) => events.push(event.data)
// after seeding one node and fetching from another:
events.filter((event) => event.type === 'peer-fetch')
```

Trigger invalidation from the host:

```powershell
Invoke-RestMethod -Method Post -Uri "http://<host-ip>:3001/api/invalidate/api/products/manual-lan-1"
```

Trigger seeded gossip from the host:

```powershell
Invoke-RestMethod -Method Post -Uri "http://<host-ip>:3001/api/gossip-seed" -ContentType "application/json" -Body '{"path":"/api/products/manual-lan-1","seq":2,"room":"manual-lan-001"}'
```

## Pass Criteria

LAN pass:

- Both machines join the same room.
- At least one edge is connected.
- Fetch returns `200`.
- Telemetry candidate type is usually `host`.

WAN/NAT pass:

- Machines are on different networks.
- Edge connects without manual browser refresh loops.
- Candidate type is usually `srflx` or `relay`.
- Fetch returns `200`.

TURN pass:

- `window.__nodexRuntimeConfig()` reports `iceTransportPolicy: "relay"`.
- At least one edge reports `selected_candidate_type: "relay"`.

Geographic pass:

- Machines are in different regions.
- Connected edge telemetry exists.
- Latency and candidate type are recorded.

## Final Rule

Record exactly what was measured. Same-machine browser-context evidence is valid deployed smoke evidence, same-city evidence is real and useful LAN/same-metro NAT evidence, but neither should be labeled global/geographic validation.
