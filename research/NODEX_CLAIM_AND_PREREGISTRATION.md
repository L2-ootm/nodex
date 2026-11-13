# Nodex: Central Claim, Pre-registration and Threat Model

Status: draft for freeze before any pilot. Labels follow `NODEX_RESEARCH_RIGOR_STANDARD.md` section 4.
Date: 2026-11-13. Simulator evidence only; no real-network measurement exists.

## 1. What is claimed (and what is not)

**Central claim (H1, safety) - Hypothesis.** In an unmodified browser, a reader admits a public snapshot only under a publisher-signed proof whose window is at most 5 s, checked against an origin-calibrated monotonic clock. Against an adversary controlling every peer, the signaling channel and invalidation delivery, no admitted read is staler than delta + epsilon (5 s + 1 s) and no read rolls back below a previously admitted version within an authority epoch. One violation falsifies H1.

**Efficiency claim (H2) - Hypothesis, simulator-grade.** With the proof detached from the payload (fixed payload per version, small renewable proof), billed infrastructure bytes are at most 0.40x of a TTL=5 s CDN at the same staleness bound, and at most 0.75x under 30 s mean sessions or 30 % hostile peers. Thresholds and scenarios: `research/freshness-sim/prereg.json`.

**Explicitly not claimed (H5).** Nodex does not reduce origin requests below a TTL=5 s CDN. Simulated origin requests are 1.2x to 13x higher. Origin offload versus a CDN is not the contribution.

**Known loss region (H4a).** At hypothetical prices Nodex costs more than the CDN for payloads of 64 KiB or less, long-tail keys and short sessions. It must self-disable there. Cost win is modelled only near 1 MiB per version (H4b), with worse p95 latency. Prices are invented; replace them with a customer invoice before any dollar claim.

**Implementation status of H2.** The detached proof (F24 in REPAIR_VALIDATION.md) now exists in the code. H2 remains a hypothesis: the 0.29x byte ratio is simulator output and has not been measured on the implementation. The next measurement is billed origin bytes per reader-hour from `test:beta-real`-style runs against a TTL=5 s baseline.

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
