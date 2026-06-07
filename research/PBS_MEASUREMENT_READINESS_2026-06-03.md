# PBS Measurement Readiness Report — 2026-06-03

## What PBS means in the Nodex context

Probabilistic Bounded Staleness `<K,T>` (Def. 7.4 of FORMAL_SYSTEM_MODEL.md):

> `P_w(c,t)` — the probability that `c` replicas have received a given write by time `t` after commit.

Nodex's PBS guarantee is: a read returns a version no more than `K` versions or `T` ms stale with probability determined by the fitted `P_w` curve. The obs_s barrier provides the *floor* guarantee (session-scoped read-your-writes and monotonic reads). PBS extends this to probabilistic freshness for cache/peer reads.

---

## Current measurement state

### Inputs to P_w(c,t)

| Input | Class | Status |
|---|---|---|
| Per-hop gossip propagation delay distribution | **Hypothesis** | Not measured from real runs |
| RTT distribution across observed peer edges | **Partially instrumented** | `current_round_trip_time_ms` captured per edge; no harness aggregation |
| Gossip fan-out (avg replicas reached by time t) | **Partially instrumented** | Gossip convergence measured in Phase 5 (p50=7ms, p95=9ms) but loopback-only |
| Write propagation delay from origin → k replicas | **Hypothesis** | Not measured end-to-end |
| Stale-read rate under controlled conditions | **Not measured** | No test currently injects a stale peer response and records whether it was rejected |
| Version divergence window (time from commit to all nodes consistent) | **Not measured** | No convergence wall-clock test |
| TURN relay fraction (affects propagation delay distribution) | **Not measured** | Requires real cross-network test |

### What the Phase 5 metrics show

From `test-results/phase-05-metrics.json` (loopback, 30 runs):
- Gossip convergence p50: 7ms, p95: 9ms, max: 12ms
- Cache/P2P hit rate: 98.02%
- These are loopback measurements. They give the best-case propagation floor, not a population distribution across real networks.

### What is needed to fit P_w

To fit `P_w(c,t)` from data:
1. Record the wall-clock time each write-originated invalidation arrives at each node: `(node_id, key, seq, t_invalidate, t_received)`.
2. For each time delta `t` after commit, count what fraction of nodes have received the write.
3. Fit a CDF (logistic or empirical) over (delta_t, fraction_received) pairs.
4. Report K/T compliance rate against declared policy budgets.

**Currently: steps 1 and 2 are partially instrumented via `gossip-propagation` MetricsEvent fields (`t_invalidate`, `t_received`, `hop_count`). The aggregation script to build the CDF does not exist.**

---

## What remains hypothesis vs. measured

| Claim | Class | Evidence required to upgrade |
|---|---|---|
| Gossip convergence under loopback in < 12ms | **Measured** (loopback only) | Already in test-results |
| PBS K=3, T=300s over real LAN | **Hypothesis** | Real LAN test + CDF fit |
| PBS K=3, T=300s under churn | **Hypothesis** | Churn/rejoin test with gossip timing |
| Direct WebRTC path reduces propagation delay vs relay | **Hypothesis** | Direct + relay test + timing comparison |
| Stale-read rate < 1% under Workload B | **Hypothesis** | Benchmark harness with injected stale responses |

---

## What is now in place to measure

With this session's changes:
1. `admitCandidate()` is wired and emits `admission-rejected` metrics. When a test injects a stale peer response (version < obs_s), the rejection will appear as a MetricsEvent. This is the first measurement path for RYW/monotonic-read violations.
2. `ice_gather_duration_ms` and `dc_open_latency_ms` are now captured per edge, enabling propagation delay analysis as part of a larger benchmark.
3. The `gossip-propagation` MetricsEvent type already carries `t_invalidate` and `t_received`. A harness can aggregate these into the CDF needed for PBS.

---

## Recommended next steps (Phase 22 scope)

1. Write `scripts/aggregate-propagation.ts`:
   - Input: `test-results/*.json` containing `gossip-propagation` MetricsEvents.
   - Output: CDF table `(delta_t_ms, fraction_received)` and p50/p95/p99 convergence times.
   - Status: **Not written**.

2. Write a Playwright test that deliberately injects a stale response (version = obs_s - 1) via the SW mock and verifies that an `admission-rejected` metric with `rejection_source: 'peer'` and `rejection_reason: 'below-session-observed'` is emitted.
   - Status: **Not written** — requires Playwright SW intercept.

3. Run gossip convergence tests on ≥2 real machines (Phase 21 blocker).

4. Compute compliance rate: for each test run, measure what fraction of reads would have been rejected under a given K/T budget.

---

## Stop condition to claim PBS as measured (not hypothesis)

All of the following must be true:
- Propagation CDF exists from real (non-loopback) test data.
- Stale-read rate measurement exists with obs_s barrier active.
- Compliance check against declared K/T budget passes at the target confidence level.
- Test runs are reproducible and logged with provenance.

**Current status: HYPOTHESIS-CLASS. Do not claim PBS as measured in any publication or demo.**
