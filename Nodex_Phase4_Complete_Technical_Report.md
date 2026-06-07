# NODEX — Phase 4 Complete Technical Report
**Phase 4 Complete | Volatility Heuristic Classifier + Routing Gate**
**Author:** Davi Emanuel Faria Bernardes
**Date:** May 2026
**Version:** 1.0 — Phase 4 complete; Phase 5 expectations defined

---

## I. Executive Summary

Phase 4 turns Nodex from a fixed P2P cache experiment into an adaptive distribution system. Before this phase, the Service Worker could choose between local cache, peer fetch, and server fallback, but it did not yet know whether a specific key was worth distributing P2P. Phase 4 adds that missing intelligence layer: a per-key volatility ledger, a zero-cost browser heuristic, three cache/distribution tiers, and a synchronous routing gate in the Service Worker hot path.

The result is a practical first version of the "AI/heuristic" idea in the original Nodex thesis. It is intentionally not an ML model. For the PoC, volatility is computed with pure TypeScript from observed invalidations and access counts, making it deterministic, inspectable, cheap, and runnable inside browser constraints.

Verification status after the 2026-05-23 stabilization pass:

```text
TypeScript:          0 errors
Vitest:              86 tests passed
Playwright:          34 passed, 1 known fixme skipped
Phase 4 verification: 6/6 must-haves verified
```

---

## II. What Phase 4 Added

### II.1 Volatility Ledger

Phase 4 introduced a new IndexedDB store:

```ts
interface VolatilityEntry {
  key: string
  change_count: number
  last_changed_at: number
  access_count: number
}
```

This ledger records how often a key changes, when it last changed, and how often it is accessed. It lives in `nodex-volatility`, introduced by `IDB_VERSION = 2`.

Purpose:

- `change_count` captures instability.
- `last_changed_at` captures recency.
- `access_count` distinguishes frequently read data from rarely used data.
- The ledger lets Nodex make per-key distribution decisions instead of treating all `/api/*` data equally.

### II.2 Pure Volatility Heuristic

The scoring module is pure TypeScript:

- `computeScore(entry, now?)`
- `classifyTier(score)`
- `deriveTTL(tier)`

The score is clamped to `[0, 1]` and uses configured weights:

```text
score =
  0.4 * change_frequency
  + 0.3 * recency_decay
  + 0.3 * (1 - access_frequency)
```

Interpretation:

- Low score means stable and P2P-friendly.
- Mid score means volatile but still cacheable for short windows.
- High score means ephemeral/server-only.

Important design decision: cold-start score `0.5` is not produced by `computeScore`. It is applied by the Service Worker when no ledger entry exists. This keeps the pure formula honest while still making unknown keys moderately cautious.

### II.3 Three Distribution Tiers

Phase 4 uses discrete tiers instead of the originally worded continuous TTL formula:

| Tier | Score Range | TTL | P2P Behavior |
|------|-------------|-----|--------------|
| Stable | `< 0.4` | 5 minutes | P2P eligible, high cache value |
| Volatile | `0.4 <= score < 0.8` | 30 seconds | P2P eligible, conservative TTL |
| Ephemeral | `>= 0.8` | 0 seconds | Server-only, no P2P distribution |

This is an accepted deviation from the earlier `base_ttl * (1 - score)` wording. The tier model is easier to reason about, easier to test, and better for an academic PoC because each decision boundary is explicit.

### II.4 Service Worker Routing Gate

The Service Worker now maintains an in-memory `scoreCache: Map<string, number>` seeded from IndexedDB during activation and refreshed on invalidation.

Hot-path behavior:

```text
request key
  -> read scoreCache synchronously
  -> if score >= VOL_P2P_GATE
       skip P2P entirely and fetch origin
     else
       local cache / peer fetch / server fallback
```

This is critical: the routing gate performs an O(1) Map lookup and does not await IndexedDB inside the fetch decision. That keeps volatility intelligence from becoming a latency tax.

### II.5 P2P Serve Gate

Phase 4 also blocks high-volatility keys on the serving side. If another peer asks this node for a key and the local score says the key is ephemeral, the Service Worker returns `found: false` before reading Cache Storage.

This prevents a node from distributing data that the local volatility model has already classified as too risky.

### II.6 Dashboard Observability

The dashboard now receives `volatility-update` events over `BroadcastChannel('nodex-metrics')`.

It exposes:

- `window.__volatilityScores` for Playwright inspection.
- A volatility panel showing key, tier, and score.
- Live updates after gossip invalidations.

This gives Phase 5 a way to inspect whether volatility routing decisions are visible and measurable during multi-node runs.

---

## III. Files and Responsibilities

| File | Role |
|------|------|
| `src/volatility/volatility.ts` | Pure scoring, tiering, and TTL derivation |
| `src/volatility/volatility.test.ts` | Unit coverage for score formula, tiers, TTLs, boundaries |
| `src/shared/config.ts` | VOL_* constants, `VOLATILITY_STORE`, `IDB_VERSION = 2` |
| `src/shared/types.ts` | `VolatilityEntry`, IDB schema extension, P2P serve message type |
| `src/sw/idb.ts` | IndexedDB v2 migration for `nodex-volatility` |
| `src/sw/sw.ts` | scoreCache, routing gate, ledger updates, serve gate |
| `src/p2p/p2p-manager.ts` | Inbound peer cache requests forwarded to SW |
| `src/dashboard/dashboard.ts` | volatility-update listener and dashboard state |
| `tests/phase-04.spec.ts` | Playwright coverage for VOL-01 through VOL-06 |

---

## IV. Requirement Coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| VOL-01: per-key volatility ledger | Complete | `VolatilityEntry`, `nodex-volatility` store, IDB writes on invalidation |
| VOL-02: weighted score in `[0,1]` | Complete | `computeScore`, 20 volatility unit tests |
| VOL-03: cold-start default `0.5` | Complete | `scoreCache.get(key) ?? VOL_COLD_START` |
| VOL-04: volatility-aware TTL | Complete with accepted deviation | discrete tiers: 300s / 30s / 0s |
| VOL-05: score `>= 0.8` bypasses P2P | Complete | request-side and serve-side gates |
| VOL-06: invalidation updates ledger | Complete | `GOSSIP_INVALIDATE` handler writes IDB and refreshes scoreCache |

---

## V. Why Phase 4 Matters

Without Phase 4, Nodex can demonstrate P2P cache mechanics, but not intelligent distribution. Every key would be treated as if it had the same stability and same business value. That is not realistic for dynamic data.

Phase 4 adds the strategic layer:

- stable keys become good P2P candidates;
- volatile keys remain cacheable but short-lived;
- ephemeral keys stay server-only;
- every invalidation improves the future routing decision;
- every cache access slowly informs whether a key is valuable enough to keep.

This is the point where Nodex becomes more than "Service Worker + WebRTC". It starts behaving like an adaptive browser-edge cache.

---

## VI. Phase 5: Features to Add

Phase 5 should not add new product theory. Its job is to make the theory measurable.

### VI.1 10-Node Playwright Harness

Add a reusable test harness that starts 10 isolated `BrowserContext` instances.

Expected features:

- each context has its own Service Worker registration;
- each context has isolated IndexedDB and Cache Storage;
- each context exposes a distinct `nodeId`;
- setup and teardown are reliable;
- no cross-test contamination from the global signaling peer map.

Expected result:

```text
10/10 contexts report:
- navigator.serviceWorker.controller !== null
- unique nodeId
- independent __peerConnections map
```

### VI.2 Explicit Test Introspection Hooks

Add safe browser-only globals for test aggregation:

- `window.__nodeId`
- `window.__latencySamples`
- `window.__gossipEvents`
- existing `window.__peerConnections`
- existing `window.__volatilityScores`

These are not production APIs. They exist so Phase 5 can measure the system without scraping UI text.

Expected result:

```text
Playwright can collect per-node:
- peer connection count
- gossip receive timestamps
- latency samples by source type
- volatility tier changes
```

### VI.3 Seedable Zipf Workload Generator

Dynamic web traffic is not uniform. Phase 5 should add a deterministic Zipf generator so repeated test runs use the same skewed workload.

Expected features:

- `makePrng(seed)`
- `buildZipfTable(n, alpha)`
- `sampleZipf(table, rng)`
- `rankToKey(rank)`

Expected result:

```text
Same seed => same key request sequence
Hot keys receive more requests than cold keys
Metrics are reproducible across test runs
```

### VI.4 10-Node Mesh Formation Test

Phase 5 must verify that the signaling server and WebRTC manager produce real connected peers across 10 contexts.

Expected result:

```text
Each node has >= 1 connected peer
Most nodes approach the configured local + long-range peer budget
No node explodes past intended peer limits in an isolated run
```

This should also expose whether the current signaling strategy needs room IDs before Playwright parallelism can return.

### VI.5 Gossip Convergence Distribution

Run at least 30 controlled invalidation events and collect:

- `t_invalidate`
- `t_received`
- per-node propagation delay
- hop count
- all-nodes-received rate
- duplicate suppression behavior

Expected result target:

```text
runs: 30
all_nodes_received_pct: >= 80%
avg_hop_count: < 10 * log2(10)
p50_ms, p95_ms, max_ms populated
dedup_verified: true
```

This is the first real evidence for or against the gossip thesis.

### VI.6 Cache Hit Rate Measurement

After seeding a key on one node, issue 100 requests across the 10-node network.

Measure:

- `sw-cache`
- `peer-fetch`
- `server-fallback`
- P2P/local-cache hit rate

Expected result:

```text
total_requests >= 100
sw_cache + peer_fetch + server_fallback >= 100
p2p_or_cache_hit_rate > 0
server_fallback fraction decreases after warmup
```

Important: if `peer-fetch` remains near zero, that is not failure by itself. It is a research result. It means the current topology, timing, or cache seeding path needs improvement.

### VI.7 Latency Percentile Report

Phase 5 should produce a JSON metrics artifact:

```text
test-results/phase-05-metrics.json
```

Required sections:

- `convergence`
- `cache_hit_rate`
- `latency_percentiles`

Expected source rows:

| Source | Expected Shape |
|--------|----------------|
| `sw-cache` | lowest latency, mostly local |
| `peer-fetch` | higher than local, ideally lower than origin fallback |
| `server-fallback` | highest latency, includes P2P timeout when peer miss occurs |

Expected output shape:

```json
{
  "convergence": {
    "runs": 30,
    "p50_ms": 0,
    "p95_ms": 0,
    "max_ms": 0,
    "all_nodes_received_pct": 0,
    "avg_hop_count": 0,
    "dedup_verified": true
  },
  "cache_hit_rate": {
    "total_requests": 100,
    "sw_cache": 0,
    "peer_fetch": 0,
    "server_fallback": 0,
    "p2p_hit_rate_pct": 0
  },
  "latency_percentiles": {
    "sw_cache": { "p50": 0, "p95": 0, "p99": 0, "count": 0 },
    "peer_fetch": { "p50": 0, "p95": 0, "p99": 0, "count": 0 },
    "server_fallback": { "p50": 0, "p95": 0, "p99": 0, "count": 0 }
  }
}
```

---

## VII. Expected Phase 5 Outcomes

### Best-Case Result

The ideal Phase 5 outcome:

- 10 nodes reliably form a connected test network.
- Gossip reaches all nodes in most runs.
- Deduplication keeps message count below naive flooding.
- Local cache hits dominate after warmup.
- Peer fetch appears as a measurable, non-zero source.
- Server fallback is measurably slower than SW cache and peer fetch.
- Metrics export is stable enough for academic graphs.

This would support the claim that Nodex is a viable PoC for browser-native dynamic read distribution.

### Realistic Result

The likely result:

- SW cache path performs strongly.
- Gossip is observable, but not perfect across all runs.
- Peer-fetch rate may be low until topology, seeding, and request timing are tuned.
- Server fallback remains common in early cold-start windows.
- The metrics will identify which bottleneck matters most: mesh formation, gossip convergence, peer availability, or cache seeding.

This is still valuable. Phase 5 is a measurement phase, not a marketing demo.

### Bad Result That Still Helps

If Phase 5 shows:

- weak peer availability;
- low peer-fetch rate;
- high server fallback;
- gossip missing nodes frequently;
- background throttling problems;

then Nodex still gains a clear research direction. It would mean the core idea needs one or more of:

- room-scoped signaling;
- anti-entropy digest repair;
- adaptive fanout;
- better seed selection;
- long-range peer selection by RTT/region;
- TURN-aware cost accounting;
- request coalescing or prefetch warmup.

---

## VIII. Claims Allowed After Phase 4

Safe claims:

- Nodex has a working browser-native volatility heuristic.
- Nodex can classify dynamic keys into stable, volatile, and ephemeral tiers.
- Nodex can prevent high-volatility keys from being served P2P.
- Nodex updates volatility state from gossip invalidations.
- Nodex has test coverage for the volatility layer.

Claims not yet allowed:

- Nodex reduces database read load at 10-node scale.
- Nodex has proven gossip convergence under churn.
- Nodex improves geographic latency in real networks.
- Nodex has production-grade cryptographic key management.
- Nodex works reliably in background/mobile browser conditions.

---

## IX. Next Step

Execute Phase 5 Plan 01:

```text
05-01 — source introspection hooks, Zipf helper, harness infrastructure, TEST-01 isolation test
```

Then execute Phase 5 Plan 02:

```text
05-02 — mesh formation, 30-run convergence, cache hit rate, latency percentiles, metrics JSON
```

After Phase 5, the project should have its first paper-grade evidence: not just "the architecture makes sense", but "here is how it behaves across 10 browser nodes."

---

*Report status: Phase 4 complete. Phase 5 should now convert architecture into measured evidence.*
