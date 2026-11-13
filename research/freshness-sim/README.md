# Breakthrough prototypes

Node 24+ (run on 26.13), no dependencies, nothing installed. All output is model or loopback evidence: label it "Hypothesis" under the rigor standard, never "Measured".

## 1. Seeded comparison harness

```
node run.mjs                 # 10 scenarios x 5 seeds x 7 arms -> out/results.csv, out/summary.md, hypothesis verdicts
node run.mjs --seeds 30      # more seeds; --scenario adversarial; --duration 600; --strict (exit 1 on a failed check)
node test.mjs                # determinism, paired workload, and 4 mutations the oracle must catch
```

- `sim.mjs`: discrete-event model. One trace per (scenario, seed) is replayed against all arms: origin-only, browser-ttl, cdn-ttl (same delta), cdn-purge, p2p-gossip (no signed window), nodex-coupled (as coded today), nodex-detached (proposed).
- `prereg.json`: parameters, hypothetical prices and the numeric pass/fail thresholds. Freeze it before a real-network pilot.
- Staleness oracle: a read that returns version v at time t is stale by `t - commit(v+1)`. A violation is staleness above delta + eps (5 s + 1 s).

Simplifications that a reviewer will ask about: reads are instantaneous for state purposes (latency is recorded, not simulated); one key per session; rooms are per key; no TURN relay, no tab suspension, no storage eviction; peer selection is one random advertised neighbour; prices are invented; the adversary replays, withholds and relabels but never floods or eclipses; signaling cost is a poll count, invalidation delay is a parameter.

## 2. Guard demo (the product wedge)

```
node guard-demo/selftest.mjs     # real guard.js against the real demo origin over loopback
node guard-demo/server.mjs       # http://localhost:4810  and  http://localhost:4810/?mode=enforce
```

- `guard-demo/guard.js`: the drop-in. One script tag, no Service Worker, no peers. Verifies the origin's signature, digest and validity window on a calibrated monotonic clock.
- `guard-demo/server.mjs`: demo origin (`signed()` is the whole server-side integration), a cache that keeps responses 20 s, a tampering path, a receipt endpoint.
- `guard-demo/index.html`: the page a prospect sees. Not checked in a real browser in this session; the self-test covers the logic only.
