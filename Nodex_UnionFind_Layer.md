# NODEX — Union-Find Layer: Topology-Aware Distributed Cache
**Author:** Davi Emanuel Faria Bernardes  
**Version:** 0.1  
**Date:** May 2026  
**Status:** Architecture proposal — pre-implementation  
**Companion document:** Nodex_Technical_Report.md

---

## 1. Overview

This document describes the integration of a **distributed Union-Find (Disjoint Set Union)** data structure into the Nodex architecture as a topology-awareness layer.

The core Nodex architecture (see companion document) handles distribution, encryption, gossip propagation, and AI-driven volatility prediction. What it currently lacks is **structural self-knowledge**: nodes act on local information without understanding where they sit in the global network topology.

The Union-Find layer solves this by giving each node a continuously updated model of the network's connected components. This enables three architectural enhancements:

1. **Component-aware gossip propagation** — eliminating redundant intra-component invalidation traffic
2. **Fragmentation detection and automatic fallback** — nodes detect isolation and respond without external coordination
3. **Representative-based fallback with thundering herd prevention** — coordinating server requests across a component without a central coordinator

These three enhancements are architecturally independent and can be implemented incrementally.

---

## 2. Union-Find — Foundations

### 2.1 Classical Definition

Union-Find (also called Disjoint Set Union, DSU) is a data structure that maintains a partition of a set of elements into disjoint subsets. It supports two operations:

```
find(x)   → returns the representative (root) of the component containing x
union(x,y) → merges the components containing x and y into a single component
```

With **path compression** and **union by rank**, both operations run in amortized O(α(n)) time, where α is the inverse Ackermann function — effectively constant for any realistic n.

### 2.2 Classical Implementation

```javascript
class UnionFind {
  constructor(n) {
    this.parent = Array.from({length: n}, (_, i) => i);
    this.rank   = new Array(n).fill(0);
    this.size   = new Array(n).fill(1);
  }

  find(x) {
    // Path compression: flatten the tree on every find
    if (this.parent[x] !== x)
      this.parent[x] = this.find(this.parent[x]);
    return this.parent[x];
  }

  union(x, y) {
    const rx = this.find(x), ry = this.find(y);
    if (rx === ry) return false; // already same component
    // Union by rank: attach smaller tree under larger
    if (this.rank[rx] < this.rank[ry]) {
      this.parent[rx] = ry;
      this.size[ry] += this.size[rx];
    } else if (this.rank[rx] > this.rank[ry]) {
      this.parent[ry] = rx;
      this.size[rx] += this.size[ry];
    } else {
      this.parent[ry] = rx;
      this.size[rx] += this.size[ry];
      this.rank[rx]++;
    }
    return true;
  }

  connected(x, y) { return this.find(x) === this.find(y); }
  componentSize(x) { return this.size[this.find(x)]; }
}
```

### 2.3 The Distributed Challenge

Classical Union-Find assumes a single authoritative structure. In Nodex, there is no central node — each browser maintains its own local copy. This creates **view divergence**: two nodes may temporarily disagree about which component they belong to.

This is acceptable and expected under the Nodex consistency model, which is **eventually consistent** by design. The topology view follows the same convergence guarantees as the data cache itself: local views diverge under network events and converge as gossip propagates the updates.

**Key invariant:** a node never needs to know the exact global topology. It only needs to answer three local questions:
- Am I in a component large enough to trust P2P distribution?
- Should I be the one making a server request, or should I wait?
- Are my gossip targets in different components than me?

These questions can be answered accurately with a local, eventually-consistent Union-Find.

---

## 3. Distributed Union-Find for Nodex

### 3.1 Node Identifier Scheme

Each Nodex node is identified by a unique string ID generated at Service Worker initialization:

```javascript
const NODE_ID = crypto.randomUUID(); // e.g. "f47ac10b-58cc-4372-a567-0e02b2c3d479"
```

The Union-Find maps these string IDs rather than sequential integers. The internal structure uses a Map for O(1) lookup:

```javascript
class NodexUnionFind {
  constructor() {
    this.parent = new Map(); // nodeId → parentId
    this.rank   = new Map(); // nodeId → rank
    this.size   = new Map(); // rootId → component size
    this.known  = new Set(); // all known node IDs
  }

  ensure(id) {
    if (!this.known.has(id)) {
      this.parent.set(id, id);
      this.rank.set(id, 0);
      this.size.set(id, 1);
      this.known.add(id);
    }
  }

  find(id) {
    this.ensure(id);
    if (this.parent.get(id) !== id) {
      this.parent.set(id, this.find(this.parent.get(id))); // path compression
    }
    return this.parent.get(id);
  }

  union(idA, idB) {
    this.ensure(idA); this.ensure(idB);
    const ra = this.find(idA), rb = this.find(idB);
    if (ra === rb) return false;
    const rankA = this.rank.get(ra), rankB = this.rank.get(rb);
    const sizeA = this.size.get(ra), sizeB = this.size.get(rb);
    if (rankA < rankB) {
      this.parent.set(ra, rb);
      this.size.set(rb, sizeA + sizeB);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
      this.size.set(ra, sizeA + sizeB);
    } else {
      this.parent.set(rb, ra);
      this.size.set(ra, sizeA + sizeB);
      this.rank.set(ra, rankA + 1);
    }
    return true;
  }

  separate(idA, idB) {
    // Soft separation: mark connection as stale, trigger re-evaluation
    // Full separation requires rebuilding from known active connections
    // See Section 3.2 for split handling
    this._markStale(idA, idB);
  }

  componentSize(id) {
    return this.size.get(this.find(id)) ?? 1;
  }

  representative(id) {
    return this.find(id); // root of the component = elected representative
  }

  isRepresentative(id) {
    return this.find(id) === id;
  }
}
```

### 3.2 Handling Component Splits (The Hard Problem)

Union-Find supports merges efficiently but not splits. When a WebRTC connection drops, the component may split — but the local Union-Find cannot detect this without rebuilding from scratch.

**Strategy: Periodic Reconstruction**

Each node maintains a list of **active connections** (live WebRTC channels). The Union-Find is rebuilt from this list on a configurable interval or on connection events:

```javascript
function rebuildTopology(activeConnections) {
  // activeConnections: Set of [nodeIdA, nodeIdB] pairs with live channels
  const uf = new NodexUnionFind();
  uf.ensure(NODE_ID); // always include self
  for (const [a, b] of activeConnections) {
    uf.union(a, b);
  }
  return uf;
}
```

**Rebuild triggers:**
- WebRTC connection closed
- Heartbeat timeout from a known peer
- Gossip message received from a previously unknown node (new connection)
- Configurable periodic interval (default: 30 seconds)

**Cost:** O(n · α(n)) where n = number of active connections per node. In practice, each browser node maintains 3-8 active WebRTC connections, so n is small and rebuild is near-instantaneous.

### 3.3 Gossip-Based Topology Propagation

Each node periodically broadcasts a **topology snapshot** — a compact representation of its local Union-Find state — to its gossip neighbors. This allows the topology view to converge across the network.

**Topology message format:**

```javascript
{
  type: "TOPOLOGY_UPDATE",
  sender: NODE_ID,
  timestamp: Date.now(),
  components: [
    { root: "f47a...", members: ["f47a...", "3c2b...", "8e1d..."], size: 3 },
    { root: "9a0f...", members: ["9a0f...", "2b7c..."], size: 2 },
  ]
}
```

Receiving nodes merge incoming components with their local view using union operations. This is safe: union is idempotent (calling it multiple times with the same pair has no effect after the first).

**Convergence guarantee:** under the same gossip propagation model used for cache invalidation, topology updates reach all nodes in O(log n) gossip rounds — identical to data invalidation convergence.

---

## 4. Enhancement 1 — Component-Aware Gossip Propagation

### 4.1 Problem

In the current gossip protocol, a node selects propagation targets randomly (2 local neighbors + 2 long-range jumps). This can result in:
- Multiple redundant propagations within the same component
- Long-range jumps that are geographically distant but topologically adjacent

### 4.2 Solution

Before selecting propagation targets, query the local Union-Find to select targets that maximize **topological coverage**:

```javascript
function selectGossipTargets(knownPeers, uf, count = { local: 2, remote: 2 }) {
  const myComponent = uf.find(NODE_ID);

  // Partition known peers by component membership
  const sameComponent     = knownPeers.filter(p => uf.find(p.id) === myComponent);
  const differentComponent = knownPeers.filter(p => uf.find(p.id) !== myComponent);

  // Select targets: prefer cross-component for long-range, same-component for local
  const localTargets  = sample(sameComponent, count.local);
  const remoteTargets = sample(differentComponent, count.remote);

  // Fallback: if not enough cross-component peers, use same-component
  const fallback = sample(sameComponent, count.remote - remoteTargets.length);

  return [...localTargets, ...remoteTargets, ...fallback];
}
```

### 4.3 Redundancy Elimination

A node that receives an invalidation message it has already processed returns a **NACK with version info** to the sender. The sender records this and avoids re-sending to that component for the current invalidation wave:

```javascript
// Invalidation wave tracking
const processedWaves = new Map(); // waveId → Set of component roots already notified

function shouldPropagateTo(targetId, waveId, uf) {
  const targetRoot = uf.find(targetId);
  const notified   = processedWaves.get(waveId) ?? new Set();
  if (notified.has(targetRoot)) return false; // component already covered
  notified.add(targetRoot);
  processedWaves.set(waveId, notified);
  return true;
}
```

**Expected impact:** 30-60% reduction in redundant gossip messages in well-connected networks, based on typical browser P2P graph density estimates.

---

## 5. Enhancement 2 — Fragmentation Detection and Automatic Fallback

### 5.1 Problem

When a subset of nodes loses connectivity to the main network (NAT failure, browser throttling, network partition), they become an isolated component. In the current architecture, isolated nodes continue serving stale cache data indefinitely without knowing they are isolated.

### 5.2 Detection

A node is considered **potentially isolated** when its component size falls below a configurable threshold:

```javascript
const ISOLATION_THRESHOLD = 3; // minimum component size to trust P2P

function checkIsolation(uf) {
  const size = uf.componentSize(NODE_ID);
  if (size < ISOLATION_THRESHOLD) {
    triggerIsolationFallback();
  }
}
```

**Isolation fallback behavior:**
1. Stop serving data to peers from local cache
2. Query server directly for all requests
3. Continue broadcasting topology updates (attempting to reconnect)
4. When component size recovers above threshold: resume normal P2P operation and re-seed the component with fresh data

### 5.3 False Positive Mitigation

A node with few known peers is not necessarily isolated — it may simply be a new node that hasn't yet discovered its neighbors. To distinguish:

```javascript
function isNewNode() {
  return (Date.now() - nodeInitTime) < BOOTSTRAP_GRACE_PERIOD; // default: 30s
}

function shouldTrustP2P(uf) {
  if (isNewNode()) return false;               // always fallback during bootstrap
  if (uf.componentSize(NODE_ID) < ISOLATION_THRESHOLD) return false;
  return true;
}
```

---

## 6. Enhancement 3 — Representative-Based Fallback (Thundering Herd Prevention)

### 6.1 Problem

When a cache miss or invalidation event occurs simultaneously for multiple nodes in the same component, all nodes may independently trigger a server fallback. This creates a **thundering herd**: a spike of identical requests to the server, precisely when the server is already under pressure (data change event).

In large deployments, a single invalidation event can trigger O(k) simultaneous server requests, where k is the number of nodes that had the stale data.

### 6.2 Representative Election

The Union-Find root of each component serves as the **elected representative** — the only node that executes the server fallback on behalf of the entire component.

```javascript
async function handleCacheMiss(key, uf) {
  const rep = uf.representative(NODE_ID);

  if (rep === NODE_ID) {
    // I am the representative: fetch from server
    const data = await fetchFromServer(key);
    cacheLocally(key, data);
    announceToComponent(key, data); // propagate to waiting peers
    return data;
  } else {
    // I am not the representative: register interest and wait
    return waitForComponentPropagation(key, rep, WAIT_TIMEOUT_MS);
  }
}
```

### 6.3 Representative Failure Handling

The representative may go offline before completing the fetch. Waiting nodes detect this via timeout and trigger **re-election**:

```javascript
async function waitForComponentPropagation(key, repId, timeout) {
  const result = await Promise.race([
    subscribeToKeyUpdate(key),                // resolves when data arrives
    sleep(timeout).then(() => "TIMEOUT"),
  ]);

  if (result === "TIMEOUT") {
    // Representative failed — check if still in component
    const currentRep = uf.representative(NODE_ID);
    if (currentRep === NODE_ID) {
      // I am now the representative (topology updated): fetch from server
      return handleCacheMiss(key, uf);
    } else {
      // New representative elected: wait again with shorter timeout
      return waitForComponentPropagation(key, currentRep, timeout / 2);
    }
  }
  return result;
}
```

### 6.4 Expected Impact

In a component of k nodes with simultaneous cache misses, the current architecture generates k server requests. With representative election:

```
requests_to_server = 1 (representative) + p (re-elections due to failure)

where p = number of representative failures before successful fetch
Expected p ≈ 0 in stable networks, rarely > 2 even under high churn
```

Server request reduction: **(k - 1 - p) / k ≈ (k-1)/k** — approaches 100% reduction as component size grows.

---

## 7. Revised Architecture with Union-Find Layer

```
┌─────────────────────────────────────────────────────────────────────┐
│  COMPONENT 0 — UNION-FIND TOPOLOGY LAYER  (new)                     │
│  Local DSU · Gossip-propagated views · Rebuild on connection events  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ topology queries
┌──────────────────────────────▼──────────────────────────────────────┐
│  COMPONENT 1 — CLIENT NODE  (Service Worker)                         │
│  Request interception · Local cache · LRU eviction                   │
│  + component-size check before P2P lookup                            │
│  + representative check before server fallback                       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ component-aware routing
┌──────────────────────────────▼──────────────────────────────────────┐
│  COMPONENT 2 — P2P NETWORK  (WebRTC + Gossip)                        │
│  Epidemic propagation · Small-world topology · Encrypted transfer    │
│  + cross-component target selection                                  │
│  + redundancy elimination via wave tracking                          │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ volatility classification
┌──────────────────────────────▼──────────────────────────────────────┐
│  COMPONENT 3 — AI VOLATILITY MODEL                                   │
│  Frequency-recency scoring · Federated learning updates              │
│  + component density as distribution factor                          │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.1 Component Density as a Volatility Factor

The Union-Find layer introduces a new input to the volatility model: **component density around the requesting node**. A node in a large, well-connected component can distribute aggressively — more nodes to carry the cache. A node in a small component should be conservative — fewer nodes to maintain freshness.

```javascript
function adjustedDistributionStrategy(key, baseStrategy, uf) {
  const density = uf.componentSize(NODE_ID);
  const factor  = Math.min(density / OPTIMAL_COMPONENT_SIZE, 1.0);
  return {
    ...baseStrategy,
    ttl:              baseStrategy.ttl * factor,         // shorter TTL in small components
    fanOut:           Math.ceil(baseStrategy.fanOut * factor), // fewer targets
    p2pEnabled:       density >= ISOLATION_THRESHOLD,
  };
}
```

---

## 8. New Research Questions

The Union-Find layer opens research questions beyond the original Nodex scope:

**RQ9:** What is the optimal isolation threshold for browser P2P networks under typical residential NAT configurations? How does this vary by network type (mobile vs. desktop vs. fixed broadband)?

**RQ10:** How quickly does the distributed Union-Find converge to a globally consistent topology view under the same gossip parameters used for cache invalidation? Is convergence faster or slower than data propagation?

**RQ11:** What is the empirical thundering herd coefficient — the average number of simultaneous server requests generated per invalidation event in a network without representative election? How does this scale with component size?

**RQ12:** Does the representative election mechanism introduce a detectable latency penalty for cache misses compared to immediate server fallback? Is the reduction in server load worth the additional wait time for non-representative nodes?

**RQ13:** How does the component-aware gossip selection affect the total propagation time compared to random selection? Is there a network density at which random selection outperforms component-aware selection?

---

## 9. Implementation Sequence

The three enhancements can be implemented independently in this order:

**Phase 1 (foundational):** Distributed Union-Find with gossip propagation. No behavior change yet — just topology tracking. Establishes the data structure and validates convergence.

**Phase 2 (highest ROI):** Representative-based fallback. Directly reduces server load. Requires Phase 1.

**Phase 3 (efficiency):** Component-aware gossip. Reduces redundant traffic. Requires Phase 1. Can run in parallel with Phase 2.

**Phase 4 (model integration):** Component density as volatility factor. Requires Phase 1 and the base volatility model (Component 3).

---

## 10. Prior Art Assessment

Union-Find in distributed systems is well-studied in the context of:
- Distributed spanning tree construction (Gallager-Humblet-Spira algorithm, 1983)
- Distributed connected components in graph streaming
- Peer sampling and topology management in unstructured P2P networks

**What is novel in this application:**
- Union-Find maintained as a locally-rebuilt, gossip-propagated structure in browser Service Workers
- Representative election for cache fallback coordination without a dedicated coordinator process
- Component density as a dynamic input to a volatility-prediction model for cache distribution decisions
- Integration of topology-awareness with the server-delay-window gossip invalidation protocol (see main report)

No prior work combining these specific elements in browser-native P2P cache architecture has been identified in the literature.

---

*This document supplements the Nodex Technical Report. All architectural decisions are subject to revision based on proof-of-concept findings.*  
*Inventor: Davi Emanuel Faria Bernardes · L2 Systems · May 2026*
