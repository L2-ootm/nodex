---
title: "Nodex — Benchmark Plan"
date: 2026-06-02
status: draft-after-external-review
source: "curated post-review research synthesis"
---

# Nodex — Benchmark Plan

## Purpose

The benchmark must answer the question raised by external academic reviewer:

> Why is Nodex better than a conventional server/CDN/edge/cache architecture?

A credible systems benchmark must measure correctness, cost, convergence, degradation under churn, server offload, and comparison against plausible baselines.

## Baselines

Nodex must be compared against:

1. **Origin-only**
   - every read goes to server.

2. **Local browser cache with TTL**
   - no P2P, fixed TTL.

3. **Server-side cache**
   - application/API cache or Redis-like simulation.

4. **CDN/edge-like cache**
   - centralized edge freshness/invalidation model.

5. **Full flood gossip**
   - naive P2P dissemination to show why selective gossip matters.

6. **Pull-only P2P**
   - peers fetch only on explicit request; no proactive metadata gossip.

7. **Nodex selective metadata gossip**
   - proposed model.

8. **Nodex under relay/TURN-heavy conditions**
   - measures whether economics survive when direct P2P fails.

## Workloads

### Workload A — Read-heavy stable data

- many readers;
- infrequent writes;
- same keys requested repeatedly.

Expected: Nodex should perform well.

### Workload B — Read-heavy moderately dynamic data

- many readers;
- periodic version updates;
- bounded staleness policy.

Expected: tests freshness/offload trade-off.

### Workload C — Write-heavy dynamic data

- frequent writes;
- low stale tolerance.

Expected: Nodex may perform poorly; important to define limits.

### Workload D — Hot key with concurrent writes

- e-commerce stock example;
- many clients read same key and attempt write.

Expected: optimistic concurrency rejects stale writes.

### Workload E — Large/cold payload

- block/chunk transfer;
- infrequent updates.

Expected: peer-assisted payload model may help.

### Workload F — Churn and tab lifecycle

- peers join/leave;
- tabs hidden/suspended;
- rejoin after offline.

Expected: tests real browser viability.

## Metrics

| Dimension | Metric | Why it matters |
|---|---|---|
| Correctness | read-your-writes violations | Session guarantee must hold |
| Correctness | monotonic-read violations | Browser must not go backwards in observed versions |
| Freshness | stale-read rate | Core risk of peer cache |
| Freshness | staleness in versions | Supports bounded-staleness(K) |
| Freshness | staleness in time | Supports bounded-staleness(T) |
| Latency | read p50/p95/p99 | User-facing performance |
| Latency | connection setup latency | WebRTC startup cost |
| Latency | propagation delay | Invalidation convergence |
| Server offload | percentage of reads not reaching origin | Main value claim |
| Cost | bytes via server/origin | Infrastructure cost |
| Cost | bytes via peers | User bandwidth budget |
| Cost | metadata bytes per useful payload | Gossip efficiency |
| Network | direct WebRTC success rate | Determines real P2P viability |
| Network | TURN/relay fallback rate | Determines cost regression |
| Churn | delivery success under join/leave | Browser overlay robustness |
| Churn | convergence after rejoin | Recovery behavior |
| Write safety | write conflict/rejection rate | Optimistic concurrency behavior |
| Local overhead | CPU/memory/storage | Browser resource acceptability |

## Correctness tests

### Read-your-writes

1. Client writes key version `v+1`.
2. Client reads from local/peer/server paths.
3. Any result older than `v+1` is violation.

### Monotonic reads

1. Client observes version `v7`.
2. Later receives peer candidate `v5`.
3. System must reject candidate or fallback.

### Bounded staleness

1. Server advances key to version `v10`.
2. Policy allows max 2 versions or 5 seconds stale.
3. Reads older than `v8` or older than 5 seconds violate policy.

### Optimistic concurrency

1. Client A and B read stock version 5.
2. A writes based on version 5; server accepts and advances to 6.
3. B writes based on version 5; server rejects or returns conflict.

## Experimental variables

- number of peers: 2, 5, 10, 25, 50;
- key popularity distribution: uniform vs Zipf;
- write frequency: low, medium, high;
- fan-out: 1, 2, 3, adaptive;
- staleness budget: strict, moderate, loose;
- connection type: direct, mixed, relay-heavy;
- churn rate: none, moderate, high;
- tab visibility: foreground, background, suspended;
- payload size: small JSON, medium object, large blocks.

## Success criteria

Nodex is promising if it shows:

- significant server read reduction on eligible workloads;
- no read-your-writes or monotonic-read violations;
- stale-read rate within declared policy;
- acceptable metadata overhead;
- acceptable direct WebRTC success or graceful fallback;
- clear advantage over TTL-only and naive flood baselines;
- honest failure cases for write-heavy/latest-value workloads.

Nodex is not promising for a workload if:

- latest-value reads are required on every request;
- TURN relay dominates the path and cost advantage disappears;
- stale-read policy is violated frequently;
- peer bandwidth/CPU cost is unacceptable;
- selective gossip costs more than origin reads.

## Deliverables

1. `benchmark-results/*.json`
2. `benchmark-results/*.csv`
3. `benchmark-results/summary.md`
4. plots for latency, offload, stale reads, propagation, direct-vs-relay;
5. final matrix comparing baselines.

## Paper framing

A credible paper should not only report “Nodex is faster.” It should show:

- when it helps;
- when it fails;
- what consistency contract it preserves;
- how much infrastructure load it removes;
- how much user/browser resource it consumes;
- how it compares to simpler alternatives.
