# Nodex Research Rigor Standard

**Owner:** Davi Emanuel Faria Bernardes  
**Project:** Nodex  
**Standard:** Build every technical decision as if the target venue is a top systems venue such as SIGCOMM, NSDI, OSDI, SOSP, EuroSys, CoNEXT, or IEEE TPDS.  
**Status:** Living standard for all Nodex research, implementation, testing, documentation, and professor collaboration.

## 1. Operating Principle

Nodex must be built with the discipline of a top-tier systems paper, not as a demo that later tries to become research.

Every claim must be supported by one of four evidence classes:

1. Formal argument.
2. Reproducible experiment.
3. Measured artifact.
4. Explicitly marked hypothesis.

If a claim does not fit one of those classes, it does not belong in the paper track yet.

## 2. Authorship And Research Posture

Davi is the originator, lead system architect, and intended first author. External professors, researchers, or lab collaborators are valuable when they materially improve:

- prior-art positioning;
- formal models;
- evaluation methodology;
- distributed-systems critique;
- experiment design;
- mathematical proof quality;
- paper framing and venue fit.

Collaboration must strengthen the work without diluting the core authorship thesis: Nodex is Davi's invention and research direction.

## 3. Big-League Bar

Nodex is not allowed to optimize for being impressive to a general audience. It must survive expert review.

A top systems reviewer will ask:

1. What exactly is new?
2. What existing system is closest?
3. Why does this not reduce to CDN, IPFS, Service Worker caching, browser mesh networking, WebRTC data transfer, gossip, or edge caching?
4. What are the assumptions?
5. What breaks under churn, NAT, mobile lifecycle, storage pressure, hostile peers, and geographic latency?
6. What is measured on real networks versus simulated or local-loopback networks?
7. What is the baseline?
8. What is the cost model?
9. What is the consistency model?
10. What is the security and privacy model?
11. What artifact lets another team reproduce the result?

All Nodex documentation must be written so those questions already have answers or explicitly named gaps.

## 4. Claim Discipline

Use these labels in reports, issues, experiment logs, and paper drafts.

| Label | Meaning | Allowed wording |
|---|---|---|
| Proven | Verified by reproducible tests or accepted formal proof | "The current artifact demonstrates..." |
| Measured | Backed by saved metrics, logs, or exported datasets | "In run X, metric Y was..." |
| Partially validated | Some conditions tested, others pending | "Validated under local loopback; external NAT pending." |
| Hypothesis | Plausible but not yet proven | "We hypothesize..." |
| Design goal | Intended property, not yet evidence | "Nodex targets..." |
| Not claimed | Outside current evidence | "This report does not claim..." |

Forbidden patterns:

- Claiming global/geographic behavior from localhost or same-machine tests.
- Claiming production readiness from demo success.
- Claiming security without threat model and adversarial tests.
- Claiming novelty before prior-art comparison.
- Claiming O(1), O(log n), or convergence without defining the model and assumptions.
- Hiding failed tests. Red gates are part of the research record.

## 5. Core Research Question

The paper-track version of Nodex must converge around one central research question:

> Can browser-native peers form a privacy-preserving, dynamic-data cache mesh that reduces origin reads and latency while preserving bounded freshness under realistic churn and NAT constraints?

Secondary questions must support this, not fragment it.

Candidate subquestions:

1. How much origin read load can be reduced as active peer count and cache coverage increase?
2. What is the freshness/staleness bound under gossip invalidation?
3. How does churn affect availability, convergence, and peer-fetch success?
4. How often does NAT traversal require TURN relay, and what does that do to the cost model?
5. How does browser lifecycle behavior affect node availability?
6. What data classes are safe or unsafe for peer distribution?
7. When is Nodex better than traditional server-side cache, CDN edge functions, or local-only Service Worker cache?

## 6. Novelty Isolation

Nodex must not present eight inventions at once. The paper needs a sharp contribution stack.

Primary contribution candidate:

- A browser-native dynamic-data cache mesh that combines encrypted peer payloads, server-sequenced freshness, WebRTC data channels, and gossip invalidation under ephemeral browser churn.

Secondary contribution candidates:

- Claim-gated external-validity harness for browser P2P systems.
- Demand-driven self-seeding when peer lookup times out.
- Component-aware fallback and representative election for churn and partition recovery.
- Volatility-aware eligibility and propagation policy for dynamic data.

Every draft must state which contributions are essential and which are optional.

## 7. Prior-Art Standard

Before any paper claim is considered stable, Nodex must be compared against the closest work in these categories:

1. CDNs and edge caching.
2. Server-side caches such as Redis and Memcached.
3. Service Worker caching and browser storage.
4. WebRTC data-channel systems.
5. Peer-assisted delivery systems.
6. IPFS, Filecoin, and content-addressed networks.
7. Gossip and epidemic dissemination protocols.
8. Cache invalidation and consistency protocols.
9. Browser lifecycle and storage-quota research.
10. Privacy-preserving and encrypted cache systems.

For each closest system, the docs must answer:

- What problem does it solve?
- What problem does it not solve?
- What does Nodex reuse?
- What does Nodex change?
- What evidence would convince a skeptical reviewer that the difference matters?

## 8. Evaluation Standard

No major claim can enter a paper draft without an evaluation plan and a saved artifact path.

Required evaluation dimensions:

1. Origin read reduction.
2. End-to-end latency by path: local SW cache, peer fetch, server fallback.
3. Gossip convergence time and receipt coverage.
4. Staleness window after updates.
5. Peer-fetch success rate.
6. Churn and rejoin recovery.
7. NAT traversal class: host, srflx, relay, unknown.
8. TURN fallback behavior and cost implication.
9. Multi-tab identity and leader election.
10. Background tab and browser lifecycle behavior.
11. Mobile browser behavior.
12. Storage pressure and quota behavior.
13. Geographic or at least cross-region behavior.
14. Adversarial or malformed peer behavior.
15. CPU, memory, bandwidth, and battery overhead where measurable.

Each experiment must record:

- date;
- commit hash;
- environment;
- browser and version;
- topology;
- number of nodes;
- network class;
- ICE candidate type when available;
- exact command;
- raw output path;
- summary output path;
- pass, partial, fail, or not measured;
- what claim it supports;
- what claim it does not support.

## 9. Baseline Standard

Nodex must be evaluated against serious baselines, not against a strawman.

Minimum baselines:

1. Direct origin fetch without cache.
2. Local Service Worker cache only.
3. Server-side cache model.
4. CDN or edge-cache approximation for static or cacheable dynamic data.
5. P2P without gossip invalidation.
6. P2P with fixed TTL only.
7. Server-broadcast invalidation where feasible as a cost comparison.

For each baseline, record:

- implementation or simulation method;
- fairness assumptions;
- what is being compared;
- what is not being compared;
- why the baseline is relevant.

## 10. Formal Model Standard

The paper track needs formal definitions for:

- node;
- active node;
- fixed node;
- ephemeral browser node;
- key;
- version;
- freshness;
- staleness window;
- cache hit;
- peer hit;
- server fallback;
- gossip round;
- convergence;
- partition;
- churn event;
- NAT failure;
- adversarial peer;
- trust boundary.

Claims involving complexity or convergence must state assumptions clearly:

- topology model;
- fanout;
- message delay distribution;
- churn distribution;
- loss model;
- number of fixed nodes;
- seed selection policy;
- browser lifecycle constraints;
- whether TURN relay is allowed.

## 11. Security And Privacy Standard

Security claims require a threat model.

Minimum threats to address:

1. Peer attempts to read cached data.
2. Peer serves stale ciphertext.
3. Peer serves malformed payload.
4. Peer lies about sequence number.
5. Peer replays old payload.
6. Peer floods gossip messages.
7. Peer enumerates keys.
8. Peer correlation or traffic-analysis risk.
9. Compromised signaling endpoint.
10. Malicious origin or misconfigured operator.

Minimum security artifacts:

- encryption contract;
- key derivation contract;
- authenticated metadata contract;
- replay protection;
- sequence-number model;
- peer trust boundary;
- what remains visible to peers;
- what is not protected;
- adversarial tests or planned tests.

## 12. Artifact And Reproducibility Standard

A paper-track Nodex result must be reproducible.

Required artifacts:

- exact source revision;
- install instructions;
- environment requirements;
- experiment commands;
- raw metrics;
- summary metrics;
- scripts that regenerate figures and tables;
- known flaky tests;
- known red gates;
- threat-model document;
- limitations document;
- external validation ledger.

No chart or table should exist only as a screenshot or manual summary. Every figure must have a source artifact.

## 13. External Validity Standard

Evidence classes must not be mixed.

| Evidence class | What it can support | What it cannot support |
|---|---|---|
| Unit test | Logic correctness | Network behavior |
| Local Playwright multi-context | Browser isolation and protocol logic | Real NAT or geography |
| Same-machine hosted smoke | Deployed endpoint integration | Real multi-device P2P |
| LAN two-machine test | Local physical network behavior | Cross-region behavior |
| Same-city different-network test | NAT and ISP behavior | Geographic latency claims |
| TURN forced relay | Relay path behavior | Direct P2P success |
| Different city or cloud region | Geographic behavior | Global-scale proof by itself |
| Beta contributor evidence | Diversity of real environments | Controlled benchmark unless protocol is strict |

Reports must explicitly state the evidence class used.

## 14. Meeting Standard For Professors

The meeting posture is:

> I built the system and I am aiming at top-tier rigor. I want the hardest critique: where does this sit in prior art, what is actually novel, and what experiments would make it publishable?

Ask for:

1. closest prior work;
2. strongest objection;
3. weakest assumption;
4. recommended formal model;
5. recommended experiment matrix;
6. venue realism;
7. whether a distributed-systems specialist should be involved;
8. what contribution would be paper-worthy if everything else were removed.

Do not ask for validation first. Ask for attack vectors first.

## 15. Paper Draft Gate

A Nodex paper draft is not allowed to call itself top-tier-ready until all gates below are green or explicitly documented as open limitations.

| Gate | Requirement | Status field |
|---|---|---|
| G1 | One-sentence contribution isolated | pending/pass |
| G2 | Closest prior-art matrix complete | pending/pass |
| G3 | Formal model written | pending/pass |
| G4 | Baseline implementation or simulation defined | pending/pass |
| G5 | Local experiments reproducible | pending/pass |
| G6 | Real P2P multi-machine test complete | pending/pass |
| G7 | NAT and TURN behavior measured | pending/pass |
| G8 | Churn/rejoin recovery green | pending/pass |
| G9 | Freshness/staleness window measured | pending/pass |
| G10 | Security threat model complete | pending/pass |
| G11 | Adversarial tests started | pending/pass |
| G12 | Raw data and scripts archived | pending/pass |
| G13 | Limitations section honest | pending/pass |
| G14 | Professor or expert critique incorporated | pending/pass |

## 16. Current Immediate Standard For Today's Real P2P Tests

For the real P2P connection tests planned today, capture at minimum:

1. Device A and Device B labels.
2. Same LAN or different networks.
3. Browser and version on each device.
4. Operating system on each device.
5. Hosted URLs used.
6. Signaling endpoint used.
7. ICE candidate type if available.
8. Whether WebRTC edge formed.
9. Whether peer-fetch occurred.
10. Which key was seeded.
11. Whether the receiving device served from peer.
12. Latency for peer path and server fallback.
13. Console errors.
14. Screenshots or exported telemetry.
15. Raw JSON/log path.
16. Final classification: pass, partial, fail, or not measured.

A failed run is valuable if it names the failure mode.

## 17. Limitations Standard

Limitations must be written before reviewers write them for us.

Known or likely limitation classes:

- NAT traversal failure;
- TURN cost and centralization tradeoff;
- mobile browser background throttling;
- Service Worker lifecycle constraints;
- Cache Storage quota limits;
- privacy leakage through metadata and access patterns;
- operator trust assumptions;
- low peer density;
- skewed key popularity;
- high-volatility data that should not be peer-distributed;
- regulatory or sensitive-data classes that must be excluded;
- Sybil or malicious-peer behavior;
- geographic sparsity;
- comparison fairness against mature CDN infrastructure.

Each limitation should have one of three statuses:

1. accepted boundary;
2. mitigation planned;
3. experiment required.

## 18. Writing Standard

Research writing must be precise, not promotional.

Use:

- "Nodex targets..." for goals.
- "The current artifact demonstrates..." for measured evidence.
- "Under local-loopback conditions..." when tests are local.
- "This remains unproven until..." when evidence is pending.
- "We compare against..." when baselines exist.

Avoid:

- "revolutionary";
- "guaranteed" unless formally proven;
- "solves" unless scoped;
- "global" without geographic evidence;
- "production-ready" before beta gates are green;
- "AI model" when the current implementation is a heuristic.

## 19. Default Conclusion

Nodex will be developed as if the target is the strongest possible research venue. The standard is not whether the system impresses non-specialists. The standard is whether it can survive the best reviewer in the room.

If the work is not ready, the docs must say exactly why. If the work fails, the failure mode becomes research data. If the work succeeds, it should already have the structure, metrics, and discipline required for a serious paper.
