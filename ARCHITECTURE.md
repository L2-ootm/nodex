# Nodex Architecture

## Runtime Split

Nodex is browser-native in the hot path. The Service Worker owns cache decisions, freshness, payload authentication/decryption, metrics emission, and demo repair hooks. WebRTC is not available in Service Worker scope, so the page thread owns `RTCPeerConnection` lifecycle and bridges requests to the SW through `postMessage`.

## Main Flow

```text
page fetch('/api/products/1')
  -> Service Worker fetch handler
  -> local Cache API + IndexedDB metadata freshness check
  -> optional P2P peer-fetch over WebRTC DataChannel
  -> origin fallback through Hono mock API
  -> encrypted payload cached locally
  -> authenticated/decrypted JSON returned to page
```

## Hosted Beta Real-Protocol Flow

The hosted beta suite is a Next.js app, but it does not simulate the protocol test. The tester `/run` route embeds the compiled Vite runtime at `/metrics.html` in an iframe and drives the same Service Worker/WebRTC path used by the research dashboard.

```text
https://nodex-beta.vercel.app/run
  -> iframe https://nodex-beta.vercel.app/metrics.html?nodexRoom=...&nodexSignalingUrl=https://nodex-beta-api.vercel.app/api/signal
  -> metrics runtime registers /sw.js
  -> p2p-manager joins /api/signal/join
  -> SDP/ICE relayed by /api/signal/send + /api/signal/poll
  -> WebRTC DataChannel opens between browser nodes
  -> node A fetches encrypted /api/products/1 from origin
  -> node B fetches /api/products/1 and receives ciphertext through cache-fetch DataChannel
  -> requesting SW authenticates/decrypts and emits peer-fetch
```

The 2026-05-27 production smoke verified two isolated hosted browser contexts with `connectedPeers: { nodeA: 1, nodeB: 1 }` and `nodeBMetrics: { "peer-fetch": 1 }`.

## Core Components

| Concern | Source |
|---------|--------|
| Service Worker routing/decrypt/P2P bridge | `src/sw/sw.ts` |
| Cache API + IndexedDB metadata | `src/sw/cache.ts`, `src/sw/idb.ts` |
| Sequence freshness | `src/sw/freshness.ts` |
| Volatility scoring | `src/volatility/volatility.ts` |
| Page-side WebRTC manager | `src/p2p/p2p-manager.ts` |
| Gossip invalidation engine | `src/gossip/gossip-engine.ts` |
| Encrypted mock origin | `src/server/mock-api.ts` |
| Room-scoped signaling server | `src/server/signaling-server.ts` |
| Hosted HTTP signaling fallback | `api/signal/[...path].ts` |
| Dashboard/metrics UI | `src/dashboard/dashboard.ts` |
| Next beta tester/admin suite | `apps/beta-suite/` |
| Deployed P2P smoke | `scripts/verify-deployed-p2p.ts` |

## Security Model

The mock origin returns AES-GCM ciphertext and headers carrying `X-Nodex-Seq`, `X-Nodex-Iv`, and `X-Nodex-Key-Id`. Cache Storage stores ciphertext. Peers serve ciphertext. The requesting Service Worker authenticates/decrypts using AES-GCM AAD:

```text
nodex:v1|{key}|{seq}|{keyId}
```

This binds freshness metadata to ciphertext and rejects forged sequence numbers.

## Demo Isolation

Phase 6 added room-scoped signaling. Playwright networks navigate to `?nodexRoom=<roomId>`, the P2P manager connects to `ws://localhost:3002/ws?room=<roomId>`, and `/api/gossip-seed` targets that room. Non-default empty rooms are pruned on close.

For Vercel-hosted validation, long-lived WebSockets are replaced by `api/signal/[...path].ts`, a room-scoped HTTP signaling transport. Browser nodes join with `/api/signal/join`, relay SDP/ICE through `/api/signal/send`, receive messages through `/api/signal/poll`, and can receive room-scoped `GOSSIP_INVALIDATE` messages through `/api/signal/gossip-seed`. The endpoint uses Vercel Blob when available and a warm-instance memory fallback so a failed Blob write does not break the active beta smoke.

## Validation Harness

`tests/helpers/harness.ts` creates isolated BrowserContexts. `tests/phase-05.spec.ts` produces the 10-node metrics report. `tests/phase-06.spec.ts` validates room isolation, product-update repair, fallback hierarchy, and JSON/CSV export.

## Phase 7 External Validity Architecture

Phase 7 is implemented as a measurement layer over the existing architecture:

- External app/API/signaling URL configuration while preserving localhost defaults.
- STUN/TURN ICE server injection with no committed secrets.
- Page-side WebRTC stats sampling from `RTCPeerConnection.getStats()`.
- Candidate-pair classification as `host`, `srflx`, `relay`, or `unknown`.
- Churn, storage-pressure, and multi-tab validation harnesses.
- Claim-gated report output that separates loopback, LAN, WAN/NAT, TURN, mobile, background, storage, and geographic evidence.
- The Next beta tester `/run` -> `/evidence` path persists protocol telemetry, Page Visibility/browser lifecycle events, and user-agent/device hints so background-tab and mobile-oriented Phase 7 evidence can be reviewed from the submitted record.
- Local stress probes for room isolation, multi-tab leader failover, repeated storage writes, relay config observability, and churn/rejoin repeatability.

## Production Gaps

- Replace demo `REVALIDATE_KEY` hook with authenticated periodic anti-entropy.
- Replace in-memory mock sequence counters with durable database LSN or `(epoch, counter)`.
- Execute the Phase 7 manual protocol to validate real LAN/TURN/NAT, background tabs, mobile browser behavior, and multi-machine geography. The Next beta suite captures lifecycle/device hints for background and mobile submissions, but the actual external behavior is only proven when testers run those categories on real devices/tabs. The 2026-05-27 hosted smoke proves deployed same-machine browser-context P2P, not cross-network geography. Two same-city computers cover LAN or same-metro NAT only; GOSP-06 requires distinct regions.
- Replace PoC session-key delivery with authenticated, non-extractable key management.
- Replace the beta HTTP signaling fallback with a production signaling service or durable low-latency coordination store before claiming production-grade stability.
