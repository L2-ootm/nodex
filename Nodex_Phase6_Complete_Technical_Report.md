# Nodex Phase 6 Complete Technical Report

**Date:** 2026-05-23  
**Status:** Complete  
**Scope:** Integration hardening, demo workflow, anti-entropy hook, paper-ready export

## Executive Summary

Phase 6 completes the current Nodex PoC milestone. The repository now includes a reproducible command, `npm run demo`, that runs the 10-node measurement harness, validates the Phase 6 demo behaviors, and writes JSON/CSV metrics suitable for academic reporting.

The most important technical change is that authenticated P2P peer-fetch responses now populate the requesting node's local encrypted cache. This turns peer-fetch from a one-off transient response into a durable distribution mechanism, which improved the final measured cache/P2P hit rate to 99.01% in the controlled loopback run.

## Delivered Features

| Area | Delivered |
|------|-----------|
| Room isolation | Signaling peers are scoped by `roomId`, with default-room compatibility preserved |
| Gossip seeding | `/api/gossip-seed` can target a room through body, header, or query param |
| Test harness | Each Playwright network receives a unique room by default |
| Anti-entropy | SW `REVALIDATE_KEY` hook compares local/latest seq against origin test seq and repairs stale state |
| Cache state | SW `GET_CACHE_STATE` hook exposes `latestSeq` and `cachedSeq` for demo assertions |
| Fallback demo | Runtime flags can disable P2P and local cache reads for controlled fallback demonstrations |
| P2P cache-fill | Peer-fetch caches authenticated encrypted payloads locally after AES-GCM validation |
| Export | `test-results/nodex-metrics-summary.json` and `.csv` are generated |

## Final Metrics

Source: `test-results/phase-05-metrics.json`

| Metric | Value |
|--------|-------|
| Convergence runs | 30 |
| Gossip p50 | 2ms |
| Gossip p95 | 6ms |
| Gossip max | 11ms |
| All-node receipt | 93.33% |
| Average hop count | 12.97 |
| Dedup verified | true |
| Total cache workload observations | 101 |
| SW-cache | 91 |
| Peer-fetch | 9 |
| Server-fallback | 1 |
| Cache/P2P hit rate | 99.01% |
| SW-cache p50/p95/p99 | 1.1ms / 1.4ms / 1.5ms |
| Peer-fetch p50/p95/p99 | 4.3ms / 6.7ms / 6.7ms |
| Server-fallback p50/p95/p99 | 9.3ms / 9.3ms / 9.3ms |

## Verification

```text
npm run typecheck
npm run build
npx playwright test tests/phase-06.spec.ts --project=chromium
npm run demo
npm test
npm run metrics:export
```

Final verification:

- 96 Vitest tests passed.
- 44 Playwright tests passed.
- 1 Playwright test remains `fixme` for ICE failure simulation.
- `npm run demo` passed and exported final metrics.

## What This Proves

Within a single-machine 10-browser-context loopback environment, Nodex now demonstrates:

- Browser-native encrypted cache serving through Service Worker + WebRTC DataChannels.
- Server-sequenced gossip invalidation across a 10-node mesh.
- Room-isolated simultaneous test/demo networks.
- Repair of missed/stale invalidation state through an explicit anti-entropy pull hook.
- Measurable fallback behavior from P2P to local SW cache to server.
- Paper-ready metrics export.

## What It Does Not Yet Prove

- Real NAT/TURN behavior.
- Background-tab stability.
- Mobile browser survivability.
- Geographic long-range routing.
- Production-grade key delivery or key rotation.
- Durable origin sequence counters across server restarts.
- Production anti-entropy scheduling or digest exchange.

## Research Readiness

The PoC is now strong enough for a controlled technical appendix or early academic collaboration demo. The honest research framing is:

> A browser-native proof of concept for mutable API-response cache coherence in ephemeral browser peers using Service Workers, WebRTC DataChannels, server-sequenced gossip invalidation, authenticated encrypted payloads, volatility-gated routing, and anti-entropy repair hooks.

The next research step should move from loopback validity to external validity: TURN, real browsers across machines, background throttling, and workload diversity.
