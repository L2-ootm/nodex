# Nodex: Central Claim, Pre-registration and Threat Model

Status: draft for freeze before any pilot. Labels follow `NODEX_RESEARCH_RIGOR_STANDARD.md` section 4.
Date: 2026-11-13. Simulator evidence only; no real-network measurement exists.

## 1. What is claimed (and what is not)

**Central claim (H1, safety) - Hypothesis.** In an unmodified browser, a reader admits a public snapshot only under a publisher-signed proof whose window is at most 5 s, checked against an origin-calibrated monotonic clock. Against an adversary controlling every peer, the signaling channel and invalidation delivery, no admitted read is staler than delta + epsilon (5 s + 1 s) and no read rolls back below a previously admitted version within an authority epoch. One violation falsifies H1.

**Efficiency claim (H2) - Hypothesis, simulator-grade.** With the proof detached from the payload (fixed payload per version, small renewable proof), billed infrastructure bytes are at most 0.40x of a TTL=5 s CDN at the same staleness bound, and at most 0.75x under 30 s mean sessions or 30 % hostile peers. Thresholds and scenarios: `research/freshness-sim/prereg.json`.

**Explicitly not claimed (H5).** Nodex does not reduce origin requests below a TTL=5 s CDN. Simulated origin requests are 1.2x to 13x higher. Origin offload versus a CDN is not the contribution.

**Known loss region (H4a).** At hypothetical prices Nodex costs more than the CDN for payloads of 64 KiB or less, long-tail keys and short sessions. It must self-disable there. Cost win is modelled only near 1 MiB per version (H4b), with worse p95 latency. Prices are invented; replace them with a customer invoice before any dollar claim.

## 2. Prior work and delta (citations from memory, NOT yet verified)

Closest: TUF timestamp role (freeze and rollback protection over untrusted mirrors), Signed HTTP Exchanges, IPNS records, Peer5/Streamroot-style P2P delivery, Maygh (EuroSys 2013). Claimed delta: seconds-scale windows instead of hours or days, per-epoch monotonic barrier, ephemeral browser mirrors, and a quantified cost of the guarantee. The mechanism is not new; the regime and the measurement are. Verify each citation and read each paper before using any novelty wording.

## 3. Threat model (research scope)

Adversary: controls all peers, signaling and invalidation delivery; can replay, delay, drop and reorder; cannot forge the publisher P-256 key; cannot alter the origin over TLS. Out of scope: compromised publisher key (rotation in OPERATIONS.md), malicious origin, side channels, browser compromise.

Verified trust assumptions in the current code (scout report 2026-11-13, spot-checked):

| Item | Status |
|---|---|
| Verify before decrypt/admit in the Service Worker (`src/sw/sw.ts:132-142`, gossip verify before delete at `:440-453`) | holds |
| Shared AES session key is returned to any tester token (`api/session-key.ts:21-25`) | design: confidentiality domain equals tester set; reader key grants no publish right. Residual: a tester can decrypt all public snapshots |
| Dev AES key used when `NODEX_SESSION_KEY_HEX` unset and `NODE_ENV` is not `production` (`src/server/session-key.ts:11`) | conditional; production throws |
| Env tester token without metadata bypasses enroll cap (`src/server/beta-coordinator.ts:1509`) | local/dev tokens only |
| Wall-clock `Date.now()` was the freshness reference (`src/crypto/publisher-proof.ts:75`) | Fixed in the Service Worker (`src/sw/trusted-clock.ts`, F22 in REPAIR_VALIDATION.md). Open: anchor lost on SW restart; page-side check at `src/p2p/p2p-manager.ts:100` still wall-clock; CDN edge can still serve an old signed response to a no-store request. Adversarial H1 test (replaying peers plus lost invalidations in a real browser) not yet written |
| No rate limit on signaling and TURN routes in `api/` | open, pilot-blocking |
| CORS `*` on bearer routes | accepted, no cookies |

**Scope limit of H1 as implemented.** Freshness is only as good as the first origin response after each Service Worker start: that response is judged at its own signed time and sets the trusted clock. A CDN edge or other cache returning an old, validly signed response to that `no-store` request anchors the clock in the past for the rest of the worker's life (characterized by the `KNOWN LIMIT` test in `tests/helpers/sw-safety.test.ts`). Restart reopens the window and falls back to wall clock. The page-side invalidation check (`src/p2p/p2p-manager.ts:100`) is wall-clock but only gates forwarding; the Service Worker re-verifies against the trusted clock before acting. A fix needs a signed server-time bound the client cannot be served stale (option C in the design review: signed server-now in the proof) or multi-sample anchoring.

## 4. Reproducibility

- Simulator: `node research/freshness-sim/run.mjs [--seeds 30] [--strict]`, writes `out/results.csv` and `out/summary.md`; CSV is byte-identical across runs.
- Mutation check: `node .../test.mjs` (the staleness oracle must catch four seeded mutations).
- Guard demo: `node .../guard-demo/selftest.mjs`.
- Gaps: no real-network arm; no browser harness in the loop; thresholds were set after seeing simulator output, so they are not pre-registered in the strict sense until frozen and dated before the first real measurement.

## 5. Measurement plan before any external claim

1. Measure real invalidation delay at the 15 s steady-state poll (simulator assumes 0.1 to 2 s) in `test:beta-real`, then on a LAN and a real NAT pair.
2. Log client clock offset distribution in guard shadow mode.
3. Freeze `prereg.json` (hash and date) before the first run that counts.
4. Report failed thresholds; H4a is expected to hold, which makes the self-disable rule a required feature.
