# Nodex steering note

Date 2026-11-13. Branch `codex/nodex-defensible` at c9da3d0. Advisory only: no production file was changed.
Labels: **VERIFIED** = I opened the cited lines or ran the command today. **INFERRED** = reasoning, not checked.

## 1. Recommendation in one paragraph

Stop selling bandwidth. The durable thing here is H1: a reader that can prove to itself, without trusting
the edge, a peer or its own wall clock, that what it shows is at most 6 s old. Make that the product
("verifiable freshness": the guard plus the detached proof, delivered over an ordinary CDN), and demote the
WebRTC mesh to an optional transport behind a flag for one narrow niche. The billed-bytes win (H2) does not
survive a compressing CDN baseline, and where it is largest it breaks the project's own user-cost limit.

## 2. Why the bandwidth axis is not the contribution

1. **The baseline does not compress, and Nodex cannot.** VERIFIED: no occurrence of compress/gzip/brotli in
   `research/freshness-sim/sim.mjs` or in `src/` and `api/` (grep). The Nodex body is base64 AES-GCM
   ciphertext (`src/sw/sw.ts:144-146`), which no edge can compress. I ran `compress-audit.mjs` (this folder);
   its wire model reproduces the repo's three measured points (1,506 / 2,530 / 83,086 B,
   `NODEX_CLAIM_AND_PREREGISTRATION.md:18`) within 10 bytes. Result on synthetic JSON, granting the simulator's
   own 68 % peer share (1 - 2.4/7.6, `RESULTS-30-seeds.md:13,18`):

   | payload | CDN brotli q5 | Nodex wire as shipped | Nodex billed / CDN billed | if gzip-then-encrypt |
   |---|---|---|---|---|
   | catalog-like 60 KiB | 8,635 B | 83,342 B | **3.05** | 0.47 |
   | number-heavy 60 KiB | 30,516 B | 83,102 B | **0.86** | 0.43 |
   | catalog-like 1 MiB | 133,987 B | 1,399,450 B | **3.30** | 0.44 |
   | number-heavy 1 MiB | 498,895 B | 1,399,282 B | **0.89** | 0.42 |

   H2a's threshold is 0.40. As shipped, Nodex bills more than a brotli CDN for ordinary JSON and misses the
   threshold even for digit-heavy JSON. With compression before encryption it lands at 0.41 to 0.57: close,
   still a miss, and before counting proof renewals and signaling. Synthetic data; the run that counts is
   `node compress-audit.mjs --file <one real snapshot>`.
2. **The money is small even on the simulator's terms.** VERIFIED arithmetic from `RESULTS-30-seeds.md:13,18,53,58`
   at the invented 0.085 USD/GiB (`prereg.json:88`): the baseline saves 6.85 MiB per reader-hour, about 0.57 USD
   per 1,000 reader-hours, and the simulator's own cost column says Nodex is dearer (3.93 vs 1.75). At 1 MiB the
   modelled saving is 6.26 USD per 1,000 reader-hours. Committed-use CDN prices are several times lower
   (INFERRED), and compression divides the saved bytes again.
3. **The win zone breaks the user-cost limit.** VERIFIED: at 1 MiB the shipped arm moves 100.16 MiB per
   reader-hour onto reader uplinks (`RESULTS-30-seeds.md:58`). H2d caps user cost at 16 MiB and is only
   checked at 64 KiB (`:226`). The only place the cost model wins is a place the project already said is
   unacceptable for users, and on metered mobile it is the reader who pays.
4. **A CDN already has a detached proof.** VERIFIED: the CDN arms model ETag revalidation (`sim.mjs:8-9`), so a
   304 is the CDN's small renewal. "Immutable payload plus tiny proof over a CDN" therefore saves no bytes over
   the ETag baseline; all of Nodex's byte saving comes from peers. Do not claim the detachment as a byte win.
5. **Origin protection is not it either.** VERIFIED: in the flash-crowd scenario the TTL CDN makes 4.3 origin
   requests per reader-hour, the shipped arm 13.3 (`RESULTS-30-seeds.md:33,38`).

Where I disagree with the brief: it asks which workload "fits the win zone". The win zone is defined by invented
prices against an uncompressed baseline; choosing a workload to fit it is backwards. Choose the workload by who
is hurt when stale data is shown as live.

## 3. What a CDN cannot do (BUILD, ranked by situation)

1. **Prove freshness at the reader.** Situation: an odds, FX, fuel-price, ticket-inventory, transit or
   election board is left open; the laptop sleeps, wakes behind a captive portal, or the edge serves
   stale-on-error during an incident; the page keeps showing old numbers as live. The simulator already shows
   the baselines break exactly here (H1e: lost purges; H1f: serve-stale-on-error, `RESULTS-30-seeds.md:216-219`).
   The guard exists (`research/freshness-sim/guard-demo/guard.js`: shadow and enforce modes, no worker, no
   peers). Product surface: "verified as of 12:03:07" that turns amber when the proof window closes. Two
   small enablers: expose `X-Nodex-Validated-At` to the page (today it is dropped, `sw.ts:147-156`) and count
   `/api/time` downgrades.
2. **Bound the pixel, not the read.** GAP in H1: it bounds staleness at admission. Nothing bounds how long an
   admitted value stays on screen. A tab that read once and froze satisfies H1 and shows hour-old data. A
   visible, proof-driven expiry in the UI is what a buyer would actually see, and no CDN can ship it.
3. **Any untrusted carrier.** Because the proof is client-checked, the payload may come from a mirror, a
   partner's cache, a corporate proxy or a peer. Peers are one carrier among several, not the headline.
4. **Peers for one niche, behind a flag.** Large (after compression still above roughly 250 kB), public, same
   for everyone, changing every 20 to 60 s, watched for a long time by a crowd: election-night result maps,
   live race or match tracking blobs. Or a crowd behind one congested uplink (venue Wi-Fi), where the CDN is on
   the wrong side of the bottleneck; that one depends on client isolation being off, which venues usually turn
   on (INFERRED). Requires explicit upload consent and the self-disable rule.

## 4. CUT

- **AES encryption of public snapshots.** The confidentiality domain is "anyone with a token"
  (`NODEX_CLAIM_AND_PREREGISTRATION.md:56`) and the route contract is public data (`OPERATIONS.md:31`). It costs
  +35 % bytes, defeats compression, and carries the session-key endpoint and the worker key-recovery dance.
  Sign the digest of the compressed bytes instead.
- **H2 / H4b dollar and byte claims** until section 2 is answered with a real payload and a real invoice.
- **TURN as a peer path.** Relayed bytes are billed bytes; a pair that needs a relay should use the CDN.
- **The four pull arms and the coupled arm** in the simulator: settled, they only add rows.
- **The 148 vs 151.7 ms argument.** Real latency will be set by the 200 ms peer deadline, not by the model:
  `tryPeerFetch` ignores not-found replies and waits out the full deadline on every miss (`sw.ts:890-896`),
  unlike `peerProofFor`, which stops when all clients have answered (`:749`).
- **Beta-suite enrollment (name, city, country, receipt)** for this stage. Freeze it; the friend test below
  does not use it.

## 5. Top risks to the claim

1. **H2 fails against a compressing baseline** (section 2.1). Likely fatal to the efficiency claim as written.
2. **H1 is conditional and the condition is unobserved.** The strict bound holds only while `/api/time` is
   reachable; the fallback anchoring is weaker and nothing logs it (`NODEX_CLAIM_AND_PREREGISTRATION.md:63`).
   No hostile peer has run in a real browser (`:31`). And H1 says nothing about on-screen staleness (3.2).
3. **The peer path may rarely fire on a real WAN.** 200 ms complete deadline (`OPERATIONS.md:43`); full
   deadline on every miss; a volatility gate that sends keys scoring 0.8 or more to origin only
   (`src/shared/config.ts:169`, applied even to peer-mode reads, `sw.ts:869`), which may exclude exactly the
   hot keys; two readers noticing a new version in the same second both go to origin; carrier NAT without
   TURN. The friend test measures each of these.
4. Novelty is thin by the document's own account (Maygh, TUF timestamp, IPNS; `:39-45`), and thresholds were
   set after seeing output (`:70`).

## 6. The one experiment

**Byte audit on a real payload, then re-run the frozen simulator with wire sizes.** Take one real snapshot from
the workload you would pitch (a public results, odds, catalog or GTFS-realtime feed saved to disk) and run
`node compress-audit.mjs --file snapshot.json`. Ten minutes. Then set per-arm payload bytes in the simulator to
those wire sizes and run `node research/freshness-sim/run.mjs --seeds 30 --strict`.
Decision rule, fixed now: if the billed ratio at the simulator's peer share is above 0.40 for the shipped wire
format, H2 is reported as failed and peers leave the product story (they stay as a research flag). If it is at
or below 0.40 only with compress-then-encrypt, that change is a precondition for any byte claim. My prediction:
above 1.0 as shipped for real JSON. This changes the decision more than the friend test, which cannot speak to
cost at all with two readers.

## 7. Friend test (two people, two networks, two laptops)

Purpose: first real-network data. It can falsify H1 in the field and say whether the peer path works across
real NATs. It cannot support H2. Thresholds, validity rules, predictions and the decision table are in
`prereg-friend.json`; freeze it (commit, record `git hash-object`) before the first run that counts.

### What already exists and is reused (VERIFIED)

- Runtime globals on `/metrics.html`: `__peerManagerReady`, `__peerConnections`, `__nodexPeerTelemetry`
  (candidate types, RTT, DataChannel open latency; no addresses), `__nodexControlMeter`
  (`src/p2p/p2p-manager.ts:251-292, 1122-1145`).
- Page-visible response headers: `X-Nodex-Source` (`sw-cache`, `peer-fetch`, `server-fallback`), `X-Nodex-Seq`
  (`sw.ts:835-837`), and the `X-Nodex-Read-Mode: peer` hook (`sw.ts:856-872`).
- Worker request observation through Playwright, as in `tests/beta-real.spec.ts:46`.
- Admin write route with `baseVersion` and `Idempotency-Key`, 70 kB body limit (`api/write/[...path].ts`).
- Signed `/api/time` returning `serverMs` (`api/time.ts`, `src/server/publisher.ts:58-62`).
- URL parameters `nodexRoom`, `nodexSignalingUrl`, `nodexApiOrigin`, `nodexTopology`, `nodexForceRelay` and the
  `#nodexBetaToken` hash (`p2p-manager.ts:440-464`); topology labels `wan-nat`, `turn-relay`
  (`scripts/collect-topology-evidence.ts`).

### What is missing today

- The page cannot see the proof's `validatedAt` or whether a renewal came from a peer (`sw.ts:147-156`).
  Staleness is therefore judged offline against the writer's log; peer-proof provenance comes from the owner's
  worker request log. A one-line `X-Nodex-Renewal: peer|origin` header would make it exact on both sides; the
  probe already records it if present.
- A deployment of this branch over https that the friend can reach. The friend cannot use localhost.

### Files in this folder

| File | Role |
|---|---|
| `friend.html` + `probe.js` | The page both people open. Embeds `/metrics.html` like `/run` does, syncs to publisher time, waits for the mesh, reads once a second for 6 min (last minute: every fifth read is peer-only), saves one JSON file. English and Portuguese. |
| `writer.mjs` | Owner only. Writes a new 48 kB version every 20 s and logs send and acknowledge times in publisher time. |
| `owner-observe.mjs` | Owner only. Opens the page in visible Chromium, logs the worker's own requests, saves the result automatically. |
| `analyze.mjs` | Merges the writer log and both result files into a verdict against `prereg-friend.json`. Exit 0 pass, 1 fail, 2 void. |
| `prereg-friend.json` | Thresholds, validity rules, predictions, decision table. |
| `mock-server.mjs`, `selftest.mjs` | Rehearsal of the harness on one machine, with injected stale and rollback faults. Not the protocol. |
| `compress-audit.mjs` | Section 2.1 and section 6. |

### Steps

Before the day (owner):
1. Freeze `prereg-friend.json`.
2. Deploy this branch (API and app at the same commit) and pass `npm run verify:deployed-p2p`. Copy
   `friend.html` and `probe.js` into `apps/beta-suite/public/` (static; `apps/beta-suite/proxy.ts:3-13` does not
   match them). Leave `NODEX_INTERCEPTOR_CAPTURE` off (`OPERATIONS.md:64`).
3. Create one tester invitation for the friend in `/admin/tokens`; revoke it after the test.
4. Rehearse alone against the deployment with two browser profiles. The first read must show a source (a
   "worker did not take control" message means the port is wrong). If the tape never shows a green tick while
   the writer runs, suspect the volatility gate (risk 3) before blaming the network.

On the day (about 20 minutes per run, on a call):
1. Owner: `$env:NODEX_ADMIN_TOKEN="..."; node research/friend-test/writer.mjs --api https://API --key friend-r1a --seconds 540 --out beta-data/friend/writer-r1a.jsonl`
2. Owner sends the friend, over a private channel, `https://APP/friend.html?room=r1a&role=A&api=https://API#nodexBetaToken=<friend token>`.
3. Owner: `node research/friend-test/owner-observe.mjs "https://APP/friend.html?room=r1a&role=B&api=https://API#nodexBetaToken=<owner token>" --out beta-data/friend`
4. Both press Start on a count of three. Tab visible, laptop on power, no VPN (note it if there is one).
5. After six minutes the friend presses Download and sends `steer-r1a-A.json`. Both leave the tab open three more minutes.
6. Owner: `node research/friend-test/analyze.mjs --writer beta-data/friend/writer-r1a.jsonl --a steer-r1a-A.json --b beta-data/friend/steer-r1a-B.json --sw-b beta-data/friend/sw-r1a-B.jsonl --json beta-data/friend/verdict-r1a.json`
7. Repeat as `r1b`. Then R2 (`r2a`, `r2b`) with the friend tethered to a phone. R3 (`&relay=1` on both links) only if TURN is configured.

### Measured, and how

| Quantity | Source |
|---|---|
| Connection type host / srflx / relay, peer RTT, DataChannel open latency | `__nodexPeerTelemetry`, sampled at connect and every 15 s |
| Time to connect | probe timer from Start to first connected peer |
| Share of payload bytes from the peer | `X-Nodex-Source` and body length on organic reads |
| Peer answers inside the deadline | 12 peer-only reads per side in the last minute |
| Time to first peer proof, peer share of renewals | owner's worker request log (or `X-Nodex-Renewal`) |
| Any read older than 6 s | read start in publisher time minus acknowledge time of the next version, with both clocks' measured uncertainty as slack |
| Rollbacks | per-reader sequence of `X-Nodex-Seq`; reads are sequential |
| Failed reads, latency p50/p95, hidden-tab share, clock drift | probe |

### Pass and fail, fixed in advance (`prereg-friend.json`)

- **Safety (one violation fails H1 in the field):** S1 zero reads beyond 6 s plus measured clock slack; S2 zero rollbacks.
- **Availability:** S3 at most 2 % failed reads per side.
- **Feasibility:** F1 connected within 45 s (relay is reported as PASS-RELAY); F2 at least 66 % of peer-only reads
  answered by the peer; F3 at least 15 % of payload bytes from the peer (ceiling 50 % with two readers); F4 first
  peer proof within 30 s of connecting and at least 30 % of renewals from the peer; F5 organic p95 at most 250 ms,
  payload reads p95 at most 800 ms.
- **Void, repeat the run:** clock uncertainty above 250 ms or drift above 200 ms, fewer than 10 acknowledged
  writes, fewer than 250 reads on a side, overlap under 240 s, more than 5 % of reads with the tab hidden.
- Each required run twice; a hypothesis passes only if both repeats pass. My predictions are written in the file
  (F2 and F3 fail, R2 does not connect).

### Privacy limits

- A direct connection shows each side's public IP address to the other side, to the signaling server and to the
  STUN server (default `stun.l.google.com`, `src/shared/config.ts:38`). Say so before the friend opens the link;
  the page says it too.
- Result files hold timings, version numbers, read sources, candidate types, browser family and major version,
  and a room name. No addresses, no token, no response bodies. `owner-observe.mjs` logs pathnames only.
- The link contains the friend's invitation: send it privately, revoke it afterwards. The admin token stays in the
  owner's environment and is never written to a log.
- No enrollment profile is collected. Keep files under ignored `beta-data/`; do not commit them. The data read is
  public test data. Expected friend upload: a few megabytes.

## 8. OPEN (facts I do not have)

- Whether `friend.html` works against the real worker: verified only against the mock. Step 4 of "before the day" is the check.
- Whether the deployed `/metrics.html` needs the `api` parameter or has defaults; whether a new key can be read before its first write.
- How the volatility score moves for a key written every 20 s (`computeScore` not read).
- CLI of `scripts/collect-topology-evidence.ts`, if the run should also produce the repo's topology manifest.
- Whether TURN is configured on the deployment (decides R3) and what a relayed gigabyte costs.
- Compression ratio of a real target payload (section 6).

## 9. Verified by running

- `node selftest.mjs --e2e` (from the repo root): 8/8 analyzer fixtures; mock origin + writer + two headless
  Chromium pages on `friend.html`, three scenarios: clean passes safety, injected stale reads fail S1 (5 reads,
  worst 7,985 ms), injected rollback fails S2. Screenshots in `out/`.
- `node compress-audit.mjs`: table in section 2.1.
- Not run: anything against the real Service Worker, a real deployment, or a second network.
