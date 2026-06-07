# NODEX — Technical Research Report
**Author:** Davi Emanuel Faria Bernardes  
**Version:** 0.7 — Phase 7 external-validity harness complete  
**Date:** May 2026  
**Status:** v1.0 PoC complete — 6/6 implementation phases done; Phase 7 automated external-validity harness and local stress suite complete with manual external UAT pending (2026-05-24)

---

## 1. Executive Summary

Nodex is a **P2P distributed dynamic cache network** where browser clients act as encrypted nodes, serving data to nearby users without querying the central server. A built-in AI model predicts data volatility and selects distribution strategy per data type. Cache invalidation propagates through a gossip protocol optimized with epidemic spread mechanics, using the server's own natural processing delay as the propagation window.

If validated, Nodex addresses one of the most expensive problems in web infrastructure at scale: database read load. The global CDN market is $28B/year. The problem Nodex attacks sits directly in that space — but with a novel angle no existing solution has fully addressed: **dynamic data freshness in a P2P client-side network**.

**2026-05-23 stabilization update:** The PoC now preserves the intended encryption contract end-to-end. The mock origin returns AES-GCM ciphertext, Cache Storage keeps ciphertext, peers serve ciphertext, and the Service Worker decrypts authenticated payloads before returning JSON to page code. Freshness metadata is now bound into AES-GCM additional authenticated data as `nodex:v1|{key}|{seq}|{keyId}`, so a peer cannot replay an old ciphertext while forging a higher sequence number.

**2026-05-24 latest full-run metrics:** 30 gossip convergence runs, p50 7ms, p95 9ms, max 12ms, all-node receipt in 90% of runs in the latest sample, average hop count 13.13, cache/P2P hit rate 98.02%, SW-cache p50 1.2ms, peer-fetch p50 5.6ms, and server-fallback p50 6.9ms. Current verification: TypeScript passes, build passes, 114 Vitest unit tests pass, Phase 7 Playwright passes 5/5, Phase 7 stress Playwright passes 5/5 plus 15/15 under repeat, beta web Playwright passes, and full `npm test` passes 55 browser tests with 1 known skip for ICE failure simulation. `npm run demo` runs Phase 5 + Phase 6 and exports JSON/CSV metrics; `npm run validate:external` runs Phase 7 and exports external-validity JSON/CSV; `npm run stress:external` runs the local stress probes; `npm run beta:stack` runs the invite-only beta coordinator.

**2026-05-23 Phase 7 planning update:** External-validity validation is now planned. The next phase adds non-localhost configuration, STUN/TURN injection, WebRTC candidate-pair telemetry, churn/multi-tab/storage/background validation, manual LAN/WAN/mobile protocols, and a claim-gated report. Until those measurements are executed, Nodex should be described as a strong local-loopback PoC rather than a proven global/geographic network.

**2026-05-24 Phase 7 execution update:** The external-validity harness is implemented. Nodex now supports non-localhost/signaling/ICE configuration, STUN/TURN JSON injection, force-relay mode, WebRTC edge telemetry from `RTCPeerConnection.getStats()`, multi-tab single-leader coordination and failover, churn/rejoin testing, room-isolation stress, storage-pressure hooks, relay config observability, and claim-gated JSON/CSV reporting. Latest Phase 7 report: 10 evidence categories, 3 pass, 1 partial, 0 fail, 6 not measured. LAN/WAN/TURN/background/mobile/geographic behavior remains human UAT and is not claimed as proven.

**2026-05-24 multi-machine guidance:** Two computers in the same city are enough for LAN validation when on the same network, and enough for same-metro WAN/NAT validation when on different networks. They are not enough to complete geographic long-range / GOSP-06; that requires different cities, regions, or cloud regions.

---

## 2. Problem Statement

### 2.1 The Standard Request Chain

Every web application today follows the same pattern:

```
Browser → Server → Database → response → Server → Browser
```

At scale, this creates two bottlenecks:

**Vertical bottleneck:** the database becomes the slowest point. More users = more queries = more load = slower responses. The solution today is vertical scaling (bigger servers) or horizontal scaling (more servers) — both expensive.

**Geographic bottleneck:** a user in São Paulo querying a server in São Francisco adds ~140ms of latency before any computation happens. CDNs solve this for static content (images, JS files) but not for dynamic database responses.

### 2.2 What Existing Solutions Do

| Solution | What it solves | What it doesn't solve |
|----------|---------------|----------------------|
| Redis / Memcached | Server-side cache | Still centralized, doesn't reduce server queries for new users |
| CDN (Cloudflare, Vercel Edge) | Geographic latency for static content | Dynamic database data |
| Service Workers | Local browser cache | Single-user only, no P2P sharing |
| IPFS / Filecoin | Distributed storage | Static/immutable content only |
| Theta Network | P2P video streaming | Video only, not general database data |

**The gap:** none of these solve the combination of (1) dynamic data, (2) P2P distribution between clients, (3) cryptographic privacy guarantees, and (4) intelligent freshness validation.

### 2.3 The Freshness Problem — Why Nobody Has Done This Well

Dynamic data changes. A product price changes. A user profile updates. A stock level drops. If Browser A has a cached version and shares it with Browser B, Browser B might receive stale data.

Previous approaches:

**TTL (Time-To-Live) Fixed:** every cached item expires after X seconds. Problems: (1) if X is too short, the cache is useless; (2) if X is too long, users get stale data; (3) it's a static rule applied to data with dynamic volatility profiles.

**Central Invalidation:** when data changes, the server notifies all nodes. Problems: (1) requires the server to track all nodes — O(n) overhead that grows with user count; (2) if the server is updating data because it's under load, adding invalidation messages increases that load; (3) all-or-nothing — no gradation.

**Neither approach uses the network topology intelligently.** This is the core gap Nodex addresses.

---

## 3. The Nodex Architecture

### 3.1 Three-Component System

```
┌─────────────────────────────────────────────────────────────────┐
│  COMPONENT 1        COMPONENT 2          COMPONENT 3            │
│  Client Node        P2P Network           Prediction Model       │
│  (Service Worker)   (WebRTC + Gossip)     (AI Volatility Layer)  │
└─────────────────────────────────────────────────────────────────┘
```

---

### 3.2 Component 1 — The Client Node (Service Worker)

A **Service Worker** is a browser-native script that runs in background, outside the page lifecycle, persisting between sessions. It intercepts all network requests before they reach the server.

In Nodex, the Service Worker acts as the local node agent:

```
Browser makes request for /api/product/123
  ↓
Service Worker intercepts
  ↓
[check 1] Is this data in local cache? 
  → YES: is it fresh? (volatility model check) → serve if fresh
  → NO: check P2P network
  ↓
[check 2] Does any nearby node have this data?
  → YES: request it via WebRTC, validate, serve
  → NO: query central server, cache result, distribute to 2 nodes
```

The Service Worker also manages the **local volatility ledger** — a lightweight record of how often each data key has changed historically, used by Component 3.

**Key property:** the Service Worker runs even when the page is closed. This means nodes remain available to serve data to the network even when the user is not actively using the application.

---

### 3.3 Component 2 — The P2P Network (WebRTC + Gossip Protocol)

#### 3.3.1 WebRTC Data Channels

WebRTC (Web Real-Time Communication) is a browser-native protocol originally designed for video/audio calls (Google Meet, Discord). Its **Data Channels** feature allows arbitrary binary data transfer directly between browsers without a central server intermediary.

In Nodex, WebRTC Data Channels form the transport layer of the P2P network. A lightweight **signaling server** (minimal infrastructure — essentially just a matchmaker) coordinates initial connections between nodes. After handshake, all data flows directly browser-to-browser.

#### 3.3.2 The Gossip Protocol — Cache Invalidation as Epidemic Spread

This is the core innovation in Nodex's freshness strategy.

**Standard gossip protocol** (existing concept): when a node receives new information, it randomly selects K neighbors and shares it. Each recipient repeats. Information spreads exponentially: 1 → K → K² → K³... reaching all nodes in O(log n) steps.

**Nodex Gossip with Timestamp Validation** (novel application):

When the server updates a data record, instead of notifying all nodes (O(n)), it notifies exactly **2 nodes** (O(1)):

```
Server updates product_price for product_123
  ↓
Server sends invalidation signal to 2 random nodes:
  { key: "product_123", updated_at: timestamp_T, new_value: encrypted_data }
  ↓
Each recipient node:
  1. Updates its own cache
  2. Selects 2 neighbors at random
  3. Sends query: "What version of product_123 do you have?"
  4. Neighbor responds with its cached timestamp
  5. If neighbor timestamp < T: send new data
  6. If neighbor timestamp >= T: already up to date, stop propagation
  7. Repeat for each updated neighbor → 2 more neighbors
```

#### 3.3.3 The Server Delay Window — Using Latency as Feature

This is the key insight that makes the gossip strategy viable:

Every database write has an inherent propagation delay before it affects read responses. In a standard PostgreSQL/MySQL setup, a write is committed, then indexes update, then replicas sync — this takes between 5-50ms depending on configuration.

**Nodex uses this window deliberately:**

```
t=0ms    : Server receives write request for product_123
t=5ms    : Database write committed
t=5ms    : Nodex invalidation signal sent to 2 nodes  ← begins here
t=50ms   : Database replicas synced, read queries return new value
t=5-50ms : Gossip propagation window
```

The gossip protocol needs approximately `log₂(n)` steps to reach all n nodes, where each step takes ~10ms over WebRTC. For 1,000 active nodes: log₂(1000) ≈ 10 steps × 10ms = ~100ms total propagation time.

This means for most realistic database configurations, invalidation completes **before or concurrent with** the new value becoming consistently readable from the central server. The gossip network and the database propagation race each other — and the gossip protocol wins or ties in most cases.

#### 3.3.4 Asynchronous Mesh Topology — The Intelligent Distribution Layer

This section describes the network topology model that makes Nodex resilient to node churn, geographic latency, and partial network failures. Three mechanisms work together:

---

##### 3.3.4.1 Node Classification: Fixed vs. Ephemeral

Nodex operates with two classes of nodes:

**Fixed Nodes (infrastructure-grade):**
A site operator can provision dedicated Nodex nodes — small, cheap server instances or edge functions — that are always online. These nodes act as **topology anchors**:
- They never go offline unexpectedly
- They maintain a more complete data index
- They serve as long-range propagation seeds (see 3.3.4.2)
- Cost: a $5/month VPS can serve as a fixed node for a small application

**Ephemeral Nodes (browser clients):**
Regular users running the Nodex Service Worker. These nodes are online only while the user is actively accessing the application.

**The key insight about ephemeral node churn:** if a node is offline, it is offline because the user is not using the application — which means the user doesn't need the data. Offline nodes are not a failure condition. They are a feature: the network automatically scales down when load decreases and scales up when users arrive. This is the inverse of traditional server infrastructure, where you pay for capacity regardless of load.

```
Traditional server: pay for peak capacity 24/7
Nodex ephemeral mesh: capacity = f(active users) at any moment
```

---

##### 3.3.4.2 Geographic Propagation with Long-Range Jumps

Pure gossip protocols propagate through local neighbors. In a geographically clustered network — say, all active users are in São Paulo — the gossip completes quickly locally but never reaches nodes in other regions.

Nodex uses a **small-world topology**: every propagation event combines local spread (geographic neighbors) with long-range jumps (geographically distant nodes, including fixed nodes).

**Propagation algorithm:**

```
Server update triggers invalidation signal
  ↓
Seed selection (runs in parallel):
  - 2 geographically nearest nodes    → fast local coverage
  - 2 geographically distant nodes    → long-range jumps
  - All fixed nodes in other regions  → guaranteed anchor coverage
  ↓
Each recipient runs local gossip to 2 nearest neighbors
  ↓
Fixed nodes in distant regions seed their local clusters
```

This produces a **two-speed propagation front**: local clusters saturate quickly via gossip (milliseconds), while fixed nodes ensure that geographically isolated clusters receive the update even if no ephemeral path exists between them.

**Why 2 local + 2 distant as default:**
- 2 local: O(log n) convergence in the local cluster
- 2 distant: ensures no region is isolated more than 1 gossip hop from a long-range seed
- All fixed nodes: zero tolerance for anchor nodes being stale — they are always directly notified

The fan-out numbers (2 local, 2 distant) are tunable parameters. High-volatility data might use 4+4. Low-volatility data might use 2+0 (local only). The volatility model from Component 3 drives this decision.

```
propagation_fan_out(key) = {
  local: 2 + floor(volatility_score(key) × 4),
  distant: floor(volatility_score(key) × 3),
  fixed_nodes: always all
}
```

---

##### 3.3.4.3 Self-Healing Topology — Auto-Seeding on Timeout

When a node needs a data item and queries the network, it broadcasts a peer discovery request with a **minimum timeout window** (configurable, default: 50ms).

**Standard path (data found):**
```
Node A needs key X
  → broadcasts peer query: "who has key X?"
  → Node B responds within timeout with encrypted payload
  → Node A receives, validates, serves user
```

**Self-healing path (timeout — data not found):**
```
Node A needs key X
  → broadcasts peer query: "who has key X?"
  → no response within timeout
  → Node A queries central server directly
  → Node A receives fresh data from server
  → Node A caches data locally
  → Node A announces to network: "I now have key X"
  → Node A becomes a new distribution point for key X
```

This mechanism has three important properties:

**1. No single point of failure for data availability.** If every node that had a given data item goes offline simultaneously (extreme churn), the next node that needs it simply seeds it from the server and becomes the new origin point for that data in the network. The network topology for any given data key is continuously regenerated by demand.

**2. Demand-driven data placement.** Data migrates toward where it is being consumed. If users in Recife start querying a product that was previously only cached by São Paulo nodes, a Recife node will timeout, seed from server, and become a local distribution point — automatically, without any central coordination.

**3. Implicit load balancing.** The central server only receives queries from nodes that genuinely cannot find data in the P2P network. As the mesh fills in (more active users, more nodes holding diverse data), server query rate decreases continuously. The system gets cheaper to operate as it grows — the inverse of traditional CDN scaling.

```
Server query rate = f(1 / active_nodes × cache_coverage)
```

As active_nodes → ∞ and cache_coverage → 1, server query rate → 0.

---

##### 3.3.4.4 Complete Topology State Machine

```
DATA UPDATE LIFECYCLE IN NODEX MESH:

Server write
    │
    ├──→ Fixed nodes (all, direct)          [t=0ms, guaranteed]
    │
    ├──→ 2 nearest ephemeral nodes           [t=~5ms, geographic]
    │        │
    │        └──→ gossip to 2 nearest each   [t=~15ms, local cluster]
    │                  └──→ ...              [t=~50ms, full local saturation]
    │
    └──→ 2 distant ephemeral nodes           [t=~10ms, long-range]
             │
             └──→ gossip to 2 nearest each   [t=~20ms, remote cluster]
                       └──→ ...              [t=~60ms, full remote saturation]

TOTAL PROPAGATION BUDGET: ~60-100ms
TYPICAL DB WRITE PROPAGATION DELAY: 5-50ms

Target: gossip completes within or shortly after DB replica sync.
Worst case: brief window where some nodes have stale data.
Fallback: volatility-aware TTL covers the stale window.

NODE FAILURE / TIMEOUT LIFECYCLE:

Query arrives at Node A
    │
    ├──→ local cache HIT + fresh    → serve immediately       [~0ms]
    │
    ├──→ local cache HIT + stale    → gossip-validate         [~10ms]
    │        └──→ validated fresh: serve
    │        └──→ confirmed stale: auto-seed from server
    │
    ├──→ peer network HIT           → receive + serve          [~20-50ms]
    │
    └──→ peer network TIMEOUT       → server query             [50ms+]
             └──→ self-seed: Node A becomes new origin
```

---

#### 3.3.5 Encryption Layer

All data in the P2P network is encrypted in two layers:

**Layer 1 — Transport encryption:** TLS over WebRTC Data Channels (standard, handled by browser).

**Layer 2 — Content encryption:** each data record is encrypted server-side with a key derived from the user's session token before entering the cache layer. A node serving data to another node cannot read the content it's serving — it only knows the data key and timestamp.

When Browser B receives data from Browser A:
- Browser B has its own session-derived key
- Browser B decrypts the payload
- If decryption succeeds: data is valid and belongs to this user's session
- If decryption fails: data is rejected, central server queried

This ensures that even a malicious node cannot inject fake data that will be accepted by a legitimate client.

---

### 3.4 Component 3 — The AI Volatility Prediction Model

#### 3.4.1 The Core Problem

Not all data changes at the same rate. Distributing everything aggressively wastes bandwidth. Distributing nothing defeats the purpose. The model needs to classify each data type by volatility and select the appropriate caching strategy.

#### 3.4.2 Volatility Classification

The model maintains a **volatility score** (0.0 to 1.0) for each data key pattern:

| Data type | Typical volatility | Distribution strategy |
|-----------|-------------------|----------------------|
| User profile photo | 0.02 | Aggressive P2P, long TTL |
| Product description | 0.05 | Aggressive P2P, long TTL |
| Product price | 0.40 | Moderate P2P, short TTL, gossip priority |
| Stock level | 0.75 | Server-only, no P2P |
| Live auction price | 0.99 | Server-only, no cache |

#### 3.4.3 Model Architecture (Phase 1 — Heuristic)

Initial implementation uses a **weighted frequency-recency-cooccurrence model**, not deep learning. This is intentional — it runs in the browser with no inference cost:

```
volatility_score(key) = 
  α × change_frequency(key, last_30_days) +
  β × recency_of_last_change(key) +
  γ × (1 - access_frequency(key))
```

Where α, β, γ are tunable weights (0.4, 0.3, 0.3 as starting point).

`change_frequency`: how many times this key type changed in the observation window  
`recency_of_last_change`: exponential decay from the most recent change  
`access_frequency`: inverse — high access items are worth caching more

This model updates locally in each node as it observes cache invalidation events. No central training required. No user data leaves the browser.

#### 3.4.4 Model Architecture (Phase 2 — Federated Learning)

In a later phase, nodes can contribute **anonymized pattern updates** to a shared model without sharing actual data. This is federated learning — used by Google for keyboard prediction (Gboard) and by Apple for Siri suggestions.

Each node sends: "key pattern X changed Y times in Z access window" — never the actual values. A central coordinator aggregates the gradients and pushes model updates. This allows the volatility model to improve across all deployments without centralizing private data.

---

## 4. Fallback Strategies

Nodex operates with a **graceful degradation hierarchy**. If any component fails, the system falls back to the next level rather than failing:

```
Level 0 (optimal):     P2P node serves fresh data
Level 1 (fallback 1):  Local Service Worker cache with gossip validation
Level 2 (fallback 2):  Optimized central invalidation (2-node gossip seed)
Level 3 (fallback 3):  Volatility-aware TTL (dynamic, not fixed)
Level 4 (last resort): Standard server query
```

### 4.1 Fallback 3 — Volatility-Aware TTL

Replaces fixed TTL with model-derived TTL:

```
TTL(key) = base_ttl × (1 - volatility_score(key)) × network_load_factor
```

A product description with volatility 0.05 gets TTL = 3600s × 0.95 = ~57 minutes.  
A product price with volatility 0.40 gets TTL = 3600s × 0.60 = ~36 minutes.  
A live auction price with volatility 0.99 gets TTL = 3600s × 0.01 = ~36 seconds.

This alone — without any P2P — is a measurable improvement over fixed TTL and represents a deployable standalone feature.

### 4.2 Fallback 2 — Optimized Central Invalidation

Instead of broadcasting to all nodes (O(n)), the server sends to 2 seed nodes and lets gossip handle propagation. The server's role becomes O(1) regardless of network size. This is a significant improvement over standard central invalidation even without the full P2P distribution layer.

---

## 5. Innovation Assessment

### 5.1 What Exists (Prior Art)

| Technology | Overlap with Nodex | Key difference |
|------------|-------------------|----------------|
| Theta Network | P2P client nodes | Video streaming only, not dynamic DB data |
| IPFS | P2P content-addressed storage | Immutable content, no freshness problem |
| Service Workers | Browser-side cache | Single-user, no P2P |
| Redis | Server-side distributed cache | Still centralized, server-to-server only |
| Standard CDN | Geographic distribution | Static content only |
| Gossip protocols (academic) | Epidemic propagation | Applied to server clusters, not browser clients |
| Firecoral (IPTPS 2009) | Browser-based P2P cache, origin-signed content | Browser extension (not SW), static content only, no gossip invalidation, no opaque encryption |
| SeedyN (Stanford 2011) | DHT browser plugin, origin-signed distribution | Browser extension (not SW), static content only, no WebRTC, no invalidation mechanism |

### 5.2 What Is Novel

Research validation (2026-05-22) confirmed: **no prior work found** combining all five of these in a single system. Each component individually has prior art; the composition does not.

The strongest single-sentence claim, per research findings:
> "Mutable API-response cache coherence in ephemeral browser peers using server-sequenced gossip and opaque encrypted payloads."

Individual novel contributions:

1. **Service Worker as a coherent mutable API cache node** — prior art (Squirrel 2002, WebCDN 2015, peer-assisted CDNs) targets static content or video segments. Dynamic database API responses require coherence across cache fills; no prior system addresses this in browser peers.

2. **Server-issued scalar sequence numbers for gossip suppression** — receiving nodes discard forwarding when `cached_seq >= invalidation_seq`. O(1) suppression check, no vector clocks needed under single-writer semantics.

3. **Opaque encrypted peer serving** — intermediate nodes hold and forward AES-GCM ciphertext they cannot decrypt. The browser page receives plaintext JSON only after the origin-scoped Service Worker authenticates and decrypts the payload. Privacy isolation from peers without a key management server in the data path. (Related patent: US8335822B2 does this for search results, not API cache.)

3a. **Authenticated freshness metadata** — AES-GCM additional authenticated data binds `key`, `seq`, and `keyId` to each ciphertext. This closes the replay/metadata-forgery gap where a peer could otherwise attach a higher `seq` to an old ciphertext.

4. **Server write delay as gossip budget** — the propagation window is the inherent database replica sync time, not a synthetic timer. This is a reframing of a latency constraint into a design parameter.

5. **Volatility-gated P2P routing** — per-key heuristic score routes cache fills to P2P, local, or origin based on observed change frequency. Distribution strategy is adaptive, not fixed per-route.

### 5.3 Patentability Assessment

**Not patentable as general concept** — P2P CDN, gossip protocols, and browser caching are all in prior art.

**Possibly patentable as narrow combination** (research validation verdict: POSSIBLY):

The most defensible independent claim shape:
> A browser-executed method in which an origin-scoped Service Worker intercepts configured API fetches, selects among local encrypted cache, WebRTC peer cache, and origin fallback using a volatility score, obtains opaque ciphertext from a peer over a reliable RTCDataChannel, authenticates/decrypts using an origin-issued session key, and updates freshness using server-issued per-key sequence numbers disseminated through a gossip channel, where receiving nodes suppress forwarding when their cached sequence is greater than or equal to the invalidation sequence.

**Critical:** file before any public disclosure (academic preprint, GitHub public, conference submission). Europe has no grace period.

**IP priority established:** `NODEX_PRIORITY_DISCLOSURE_2026-05-20_assinado.pdf` — Gov.br signed, hash `51c799f306973b737c00d7aeaef80c90c3c5e4c453d1bb97164748746e08acc3`.

**Patent timing:** The Gov.br priority disclosure (2026-05-20) predates any public research or publication. The US 1-year grace period and Brazil 12-month grace period both run from that date. **PCT filing deadline: 2027-05-20.** INPI Brazil averages 11 years to grant — irrelevant for international rights, which are secured via PCT entry at 30 months.

---

## 6. Research Questions (For Academic Collaboration)

These are the open questions that make this a legitimate research topic:

**RQ1:** What is the optimal gossip fan-out factor K for browser-to-browser networks given typical WebRTC connection establishment latency?

**RQ2:** How accurately can a locally-trained frequency-recency model predict data volatility compared to ground truth change logs? What is the false positive rate (distributing data that changes before serving)?

**RQ3:** Does the server write propagation delay reliably provide sufficient window for gossip completion across typical network topologies? What are the failure conditions?

**RQ4:** What is the performance overhead of the Service Worker interception layer on standard browser request latency? Is it negligible?

**RQ5:** In a federated learning setup for volatility model updates, how quickly does the model converge to useful volatility estimates with N nodes?

**RQ6:** In a hybrid fixed/ephemeral topology, what is the minimum ratio of fixed nodes to ephemeral nodes required to guarantee propagation completion within the DB write delay window?

**RQ7:** What is the empirical auto-seeding rate in a real network — how often does a node timeout and self-seed vs. find data in the P2P network — and how does this rate evolve as network density increases?

**RQ8:** How does geographic long-range jump count (distant seed nodes) affect total propagation time in networks where users are geographically clustered? Is there a diminishing returns threshold beyond 2 distant seeds?

---

## 7. Proof of Concept Roadmap (8 Weeks)

### Week 1-2: Service Worker Cache Layer
- Implement Service Worker that intercepts API requests
- Local cache with LRU eviction
- Baseline measurement: cache hit rate and latency reduction vs. direct server query
- **Deliverable:** working Service Worker cache with metrics dashboard

### Week 3-4: WebRTC P2P Data Channel
- Two-browser test harness (two Chrome tabs, same machine)
- WebRTC Data Channel established via local signaling server
- Encrypted data transfer between nodes (Layer 2 content encryption)
- **Deliverable:** two browsers exchanging encrypted cache entries

### Week 5-6: Gossip Protocol Implementation
- Gossip invalidation with timestamp comparison
- Simulated server update triggering 2-node seed invalidation
- Propagation time measurement across simulated network of 10 nodes
- **Deliverable:** gossip propagation demo with timing metrics

### Week 7-8: Volatility Model + Integration
- Heuristic volatility scorer (frequency-recency model)
- Full integration: Service Worker + WebRTC + Gossip + Volatility
- End-to-end demo: product price update propagates through 10-node network
- Latency and consistency metrics vs. baseline (standard server query)
- **Deliverable:** integrated proof of concept with comparison metrics

---

## 8. Strategic Value

### 8.1 Technical Value
Addresses a real and expensive problem in web infrastructure. Database read load is one of the top costs for any application at scale. A 30-40% reduction in database queries through client-side P2P distribution would have measurable economic impact for any mid-to-large web application.

### 8.2 Research Value
The combination of gossip protocols, browser-native P2P, AI volatility prediction, and the server-delay-window insight creates at least 2-3 publishable research contributions. The research questions above map directly to the methodology of the iSEL lab at UFU.

### 8.3 Application Value (College Applications)
Nodex as an active research project, co-developed with a university professor, transforms the profile from "startup founder" to "founder + researcher." This is the gap in the current application profile. It provides material for:
- Additional Information sections
- Why CS / Why Major essays
- Activity slot as "Independent Researcher"
- Potential paper co-authorship before submission deadlines (November 2026)

### 8.4 Long-Term Commercial Value
If proof of concept validates, the natural path is:
1. Open-source the core protocol (drives adoption and establishes standard)
2. Commercial layer: managed signaling infrastructure, analytics dashboard, enterprise support
3. Licensing model for the volatility prediction layer

This is identical to how Redis (open core) and Kafka (Apache foundation + Confluent commercial) became infrastructure standards.

---

## 9. Open Questions

*Updated 2026-05-22 with research validation findings.*

1. **Storage quota:** MDN documents origin storage up to 60% of total disk — the "50MB Chrome limit" is not official spec, likely empirical/mobile-specific. Browser-level eviction (LRU by origin) can delete the entire origin's Cache API and IndexedDB simultaneously; Nodex's own LRU does not protect against this.

2. **Crypto/key model:** the PoC now authenticates payload metadata with AES-GCM AAD, but still uses an extractable session key delivered by `/api/session-key`. Production needs authenticated key delivery, non-extractable keys, rotation, revocation, and per-user/per-session scope.

3. **NAT traversal and TURN cost:** STUN-only success rate is ~70-82% measured. 20-25% of WebRTC sessions require TURN (~$0.40/GB Twilio US/EU). The bandwidth-savings claim must account for TURN-relayed traffic separately. TURN fallback is mandatory.

4. **Gossip convergence under churn:** fanout=3 is below `ln(n)` for n > ~20 nodes. For n=1000+, convergence requires either adaptive fanout or a pull-based anti-entropy repair loop. This is required before any academic freshness claim.

5. **Anti-entropy path is demo-scoped.** Phase 6 added an explicit Service Worker `REVALIDATE_KEY` repair hook that compares local/latest sequence against the origin test sequence endpoint and deletes stale cache state. Production still needs authenticated periodic seq-digest exchange or TTL-forced origin revalidation.

6. **Sequence counter durability:** server restart resetting seq to 0 causes nodes with higher cached_seq to reject valid new data. Requires durable LSN or `(epoch, counter)` pair with durable epoch.

7. **200ms timeout validity:** only safe for already-open DataChannels. ICE negotiation takes seconds. Current server-fallback cost is ~200-250ms vs. direct origin ~35ms — meaningful latency overhead when no peer is available.

8. **Background tab degradation:** browsers throttle JS, timers, and postMessage in background/inactive tabs. Mobile backgrounding is more aggressive. The PoC measured foreground loopback contexts only; background/mobile behavior remains a post-PoC validation item.

9. **Regulatory:** ciphertext addresses content confidentiality but peer metadata (IP, key IDs, timing, frequency) remains visible. GDPR/LGPD legal analysis required before production; technical encryption alone is not sufficient.

---

## 10. Glossary

**Service Worker:** background browser script that intercepts network requests, runs independently of the page lifecycle.

**WebRTC (Web Real-Time Communication):** browser-native protocol for peer-to-peer audio, video, and data transfer without a central server.

**Gossip Protocol (Epidemic Protocol):** distributed algorithm where nodes randomly inform a small set of neighbors of updates, who repeat the process. Information spreads in O(log n) steps.

**Small-World Network Topology:** network structure combining dense local connections with sparse long-range connections, enabling fast global propagation regardless of local cluster density. Used in BitTorrent, social networks, and neural architectures.

**Node Churn:** the continuous process of nodes joining and leaving a P2P network. In Nodex, churn is a non-issue for offline nodes (offline = user not using app = user doesn't need data) and handled by auto-seeding for online nodes.

**Self-Healing Topology:** network property where nodes that cannot find data automatically seed it from the authoritative source and become new distribution points, without central coordination.

**Long-Range Jump:** in gossip propagation, a direct connection to a geographically or topologically distant node, ensuring global propagation speed independent of local cluster density.

**Fixed Node:** a dedicated, always-online Nodex node acting as a topology anchor and guaranteed propagation point for a geographic region. Optionally provisioned by site operators.

**Ephemeral Node:** a browser-based Nodex node, online only while the user is actively using the application. Scales with traffic automatically.

**Auto-Seeding:** the process by which a node that fails to find data in the P2P network queries the central server, caches the result, and announces itself as a new distribution origin for that data key.

**TTL (Time-To-Live):** cache expiry mechanism. After TTL seconds, a cached item is considered stale and must be re-fetched.

**Volatility:** how frequently a data item changes over time. High volatility = changes often = risky to cache aggressively.

**Federated Learning:** machine learning approach where model updates are computed locally on-device and only gradients (not raw data) are shared with a central coordinator.

**P2P (Peer-to-Peer):** network architecture where participants communicate directly with each other without a central intermediary.

**CDN (Content Delivery Network):** geographically distributed server infrastructure that serves static content from nodes close to the user.

**Prior Art:** existing patents, publications, or public knowledge that prevents a new invention from being patented.

---

*This document is a working technical specification. All architectural decisions are subject to revision based on proof-of-concept findings.*

---

## 11. Research Validation Summary (2026-05-22)

External research agent ran a full literature, feasibility, publication, and patent analysis. Key verdicts:

| Domain | Verdict |
|--------|---------|
| Novelty | PROBABLY YES — full combination appears novel; individual components are prior-arted |
| Architecture soundness | Coherent with mandatory origin fallback; three fragile assumptions require measurement |
| Publication path | IEEE TPDS or CoNEXT realistic; SIGCOMM/NSDI requires 100-1000 node testbed + formal model |
| Patent viability | POSSIBLY — narrow combination claim; broad claims blocked by prior art |

**Strongest framing confirmed by literature search:**
> Mutable API-response cache coherence in ephemeral browser peers using server-sequenced gossip and opaque encrypted payloads.

**Closest prior work with no overlap on the combination:** Squirrel (PODC 2002), CoralCDN (NSDI 2004), WebCDN (2015), Firecoral (IPTPS 2009), SeedyN (Stanford 2011), peer-assisted WebRTC CDNs (Peer5, Streamroot). All use browser extensions (not SW) or target static/video content. None combine SW + dynamic data + gossip invalidation + opaque encrypted payloads.

**Three fragile assumptions requiring Phase 5 measurement:**
1. Pre-established WebRTC peer availability (STUN fails ~20-30%; TURN adds cost)
2. Background/mobile tab stability (browsers throttle; mobile kills tabs aggressively)
3. Gossip convergence at n > 100 (fanout=3 insufficient without anti-entropy)

**Phase 5 measurement result (2026-05-23):** in the controlled 10-node loopback harness, peer availability and cache serving were validated. The initial Phase 5 run produced 50 peer-fetch responses, 46 SW-cache responses, and only 5 server-fallback responses in a 101-observation workload. Gossip reached all 10 nodes in 83.33% of 30 runs, satisfying the Phase 5 gate but exposing a narrow convergence margin.

**Latest local hardening result (2026-05-24):** after room-scoped signaling, explicit anti-entropy repair, stale peer-payload guards, P2P cache-fill, and Phase 7 harness additions, the final full run produced 91 SW-cache responses, 9 peer-fetch responses, and 1 server-fallback response in a 101-observation workload. Gossip reached all 10 nodes in 100% of 30 runs in the final sample. This strengthens the local-loopback PoC claim but does not replace real TURN/NAT/churn/background validation.

**Architecture gaps after Phase 6:**
- Production anti-entropy / pull revalidation path (the current implementation is an explicit demo/test hook)
- Sequence counter durability (server restart must not reset counters below cached values)
- External validity under TURN, NAT, churn, background tabs, mobile, and multi-machine geography
- Multi-tab identity coordination so one browser profile/origin does not register duplicate active P2P nodes

**Phase 7 response:** The external-validity phase converts these gaps into falsifiable requirements and implemented the local measurement harness. It records selected candidate type (`host`, `srflx`, `relay`, `unknown`), ICE/connection state transitions, churn recovery, storage-pressure behavior, and evidence classes for loopback, LAN, WAN/NAT, TURN, background, mobile, and geography.

**Top risk:** P2P availability is too low under real NAT/churn/background conditions — if this is true, Nodex degrades to a complex local cache with occasional peer hits. The completed PoC bounds the local foreground case; Phase 7 now supplies the test harness and report gates for real network, TURN, background, mobile, and geography validation, but those external runs still need to be executed manually.

**Second research iteration complete (2026-05-22):** novelty verdict confirmed — "genuinamente nova" for the full combination. Firecoral (IPTPS 2009) and SeedyN (Stanford 2011) identified as closest academic predecessors; both differ on all four key dimensions (SW vs extension, dynamic vs static, gossip invalidation vs none, opaque encryption vs signed plaintext).
