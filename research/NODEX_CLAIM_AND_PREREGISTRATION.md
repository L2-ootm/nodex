# Nodex: Central Claim, Pre-registration and Threat Model

Status: draft for freeze before any pilot. Labels follow `NODEX_RESEARCH_RIGOR_STANDARD.md` section 4.
Date: 2026-11-13. Simulator evidence only; no real-network measurement exists.

## 1. What is claimed (and what is not)

**Central claim (H1, safety) - Hypothesis.** In an unmodified browser, a reader admits a public snapshot only under a publisher-signed proof whose window is at most 5 s, checked against an origin-calibrated monotonic clock. Against an adversary controlling every peer, the signaling channel and invalidation delivery, no admitted read is staler than delta + epsilon (5 s + 1 s) and no read rolls back below a previously admitted version within an authority epoch. One violation falsifies H1.

**Efficiency claim (H2) - Hypothesis, simulator-grade.** With the proof detached from the payload (fixed payload per version, small renewable proof), billed infrastructure bytes are at most 0.40x of a TTL=5 s CDN at the same staleness bound, and at most 0.75x under 30 s mean sessions or 30 % hostile peers. Thresholds and scenarios: `research/freshness-sim/prereg.json`.

**Explicitly not claimed (H5).** Nodex does not reduce origin requests below a TTL=5 s CDN. For the original detached and coupled arms, simulated origin requests are 1.2x to 13x higher; for the design as shipped the simulator shows rough parity (see the exploratory table below). Origin offload versus a CDN is not the contribution and is not claimed either way.

**Known loss region (H4a).** At hypothetical prices Nodex costs more than the CDN for payloads of 64 KiB or less, long-tail keys and short sessions. It must self-disable there. Cost win is modelled only near 1 MiB per version (H4b), with worse p95 latency. Prices are invented; replace them with a customer invoice before any dollar claim.

**Implementation status of H2.** The detached proof with edge-served renewal and peer proof exchange (F24 to F27 in REPAIR_VALIDATION.md) exists in the code and in two real browsers. H2 remains a hypothesis: the byte ratios are simulator output and have not been measured on the implementation. The next measurement is billed origin bytes per reader-hour from `test:beta-real`-style runs against a TTL=5 s baseline.

**Measured (implementation, in-process, 2026-11-13; `npm run measure:renewal`, data in `research/measurements/renewal-cost-2026-11-13.csv`).** A proof renewal response is a constant 839 bytes (headers only). A full payload response is 1,506 bytes at 256 B of plaintext, 2,530 at 1 KiB, 12,086 at 8 KiB, 44,858 at 32 KiB and 83,086 at 60 KiB. Renewal is therefore 56 % of a full response at 256 B, 33 % at 1 KiB, 6.9 % at 8 KiB and 1.0 % at 60 KiB. This supports H4a (small payloads gain little) and says renewal pays off from roughly 8 KiB. It measures bytes per renewed read only; it does not measure hit rates, churn or billed cost. Excludes TLS and HTTP framing. Request headers are not counted.

**Model versus implementation (exploratory, simulator-grade, 30 seeds; `research/freshness-sim/RESULTS-30-seeds.md`).** Shipping the first renewal path (a pull from origin per expired read) and then modelling it showed it was not the design H2 had been tested on. Four arms were added after observing the original results, with the original thresholds unchanged and marked exploratory in `prereg.json`; their safety checks gate `--strict`, their efficiency and latency checks do not. Baseline scenario means (hypothetical prices):

| Arm | origin req/reader-hour | billed MiB/reader-hour | peer MiB/reader-hour | $/1k reader-hours | p95 ms |
|---|---|---|---|---|---|
| TTL=5 s CDN | 80.6 | 9.72 | 0 | 1.752 | 59 |
| detached, proof gossip (original design) | 98.9 | 2.80 | 9.01 | 3.858 | 88 |
| shipped first: origin pull per expired read | 630.8 | 3.30 | 6.07 | 5.495 | 237 |
| origin pull + edge-served 1 s proof | 212.0 | 3.53 | 6.12 | 4.919 | 198 |
| edge-served + background renewal | 241.3 | 3.69 | 6.12 | 5.183 | 154 |
| **as shipped now: edge-served proof + peer proof exchange** | **74.2** | **2.87** | **6.65** | **3.932** | **148** |

Outcome for the shipped design (`nodex-shipped`): in the simulator, safety holds (zero admitted reads older than delta + epsilon and zero rollbacks in every scenario, including replaying peers, lost invalidations and wrong clocks); billed bytes are at most 0.388 of the CDN (threshold 0.40) and at most 0.63 under 30 s sessions or hostile peers; modelled cost is 0.58 of the CDN at 1 MiB per version and still above the CDN for small payloads, long tails and short sessions (the kill zone stands, so self-disable remains required); peer upload and control stay under 9.92 MiB per reader-hour. **It misses on two points:** worst-seed p95 latency is 151.7 ms against the 150 ms threshold (mean 148 ms), and origin requests are at parity with the CDN (0.89 to roughly 1), so the H5 statement "origin requests are not reduced" no longer holds for this design as a lower bound and should not be claimed either way. The pull-only designs fail latency (198 to 237 ms) and, without peer proof exchange, the 1 MiB cost threshold; that is why the peer exchange and the edge-served proof exist. Peer proofs are signature-verified in the Service Worker before use (tested with a forged-signature peer in the worker harness; no hostile peer has been run in a real browser), so a hostile peer can only waste one cheap origin renewal. Safety of reuse and edge caching rests on one property: the signed `validUntil` stays at `validatedAt + 5 s`, so a cached, reused or peer-supplied proof only shortens the reader's usable window.

Still true of every number above: invented prices, an idealized network model, no real browsers or NAT, and thresholds that were set after seeing simulator output. At 30 seeds the original cut claim H3a also fails (the coupled design saves up to 33 % of billed bytes, not under 30 %); it is reported, not re-tuned. The sequence-authority read per request still scales with reads and is not modelled or reduced.

## 2. Prior work and delta

Verified by web search on 2026-11-13 (search summaries, not a read of each paper; read before citing):

- **Maygh** (Zhang, Zhou, Mislove, Sundaram, EuroSys 2013, pp. 281-294): browsers of visiting users serve static content to each other under an operator-run coordinator; content is identified by hash; evaluated by replaying one week of Akamai image logs from etsy.com in simulation (about 75 % bandwidth reduction at the 95th percentile, per the authors' poster). This is the closest system and already covers browser peers with hash integrity for static content. Nodex cannot claim "browser CDN" novelty.
- **TUF timestamp role**: a regularly re-signed timestamp that makes freeze (replayed outdated metadata) and rollback attacks detectable. Nodex's renewable proof is the same idea at a seconds scale.
- **IPNS records**: signed records with an RFC 3339 end-of-life validity; selection prefers the highest sequence number and latest EOL; implementations separate a cache TTL from validity (kubo defaults of 24 h EOL and 1 min TTL come from an issue tracker, not the spec).

Not verified: Signed HTTP Exchanges validity limit (believed to be at most seven days; the "Response lifespan" appendix of the IETF draft was not read); Peer5 and Streamroot (not searched).

Claimed delta, restated against what is verified: Maygh addresses static, hash-addressed content, where staleness is not a problem. Nodex targets versioned dynamic snapshots, so its contribution is the freshness guarantee (signed window of at most 5 s, calibrated clock, per-epoch monotonic barrier, renewal of held bytes) and its measured cost. TUF and IPNS supply the signing and validity pattern; the regime (seconds) and the browser-mirror setting are the difference. Required before any novelty wording: read Maygh and the TUF specification in full and write the comparison against them.

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
| No rate limit on signaling, TURN and session-key routes in `api/` | Fixed (F23): per-credential limiter, per-instance memory. Open: shared store for a hard global ceiling; `/api/products` read path and `gossip-seed` (service credential) are not limited |
| CORS `*` on bearer routes | accepted, no cookies |

**Scope limit of H1 as implemented.** The freshness clock is anchored once per Service Worker start by a signed, nonce-bound server time, anchored at the upper bound serverMs plus the round trip, so the reader's clock can run ahead of true time by at most the RTT (valid proofs rejected slightly early) but never behind it; a cached or replayed response cannot match the fresh nonce. If `/api/time` is unreachable the reader falls back to anchoring from the first no-store origin response, and in that mode a CDN edge returning an old, validly signed response would anchor the clock in the past (characterized by the `KNOWN LIMIT` test in `tests/helpers/sw-safety.test.ts`). The anchor is in memory, so each restart repeats one challenge. The page-side invalidation check (`src/p2p/p2p-manager.ts:100`) is wall-clock but only gates forwarding; the Service Worker re-verifies against the trusted clock before acting. Because the anchor is an upper bound, an attacker who delays the challenge reply cannot make the client admit older proofs; it can only add up to the 3 s timeout of early rejection. An attacker who blocks the challenge entirely forces the weaker fallback anchoring (retried every 30 s, not yet measured or logged), so H1's strict bound holds only while `/api/time` is reachable; a downgrade counter is required before the claim is tested adversarially.

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
