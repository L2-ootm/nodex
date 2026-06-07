---
title: "Nodex — Selective Gossip Algorithm"
date: 2026-06-02
status: draft-after-external-review
source: "curated post-review research synthesis"
---

# Nodex — Selective Gossip Algorithm

## Problem

Classical epidemic dissemination tends to push broadly. external academic reviewer identified this as a core issue: Nodex cannot send every key to every peer. It must place information near the peers that need it, while avoiding redundant traffic and preserving freshness.

## Design principle

Nodex should use **metadata-first selective gossip**:

1. advertise interest and inventory compactly;
2. gossip metadata/version digests more broadly than payloads;
3. transfer payloads only on demand;
4. adapt fan-out based on interest, popularity, volatility, and network cost.

This is closer to libp2p/gossipsub than to naive flooding.

## Overlay model

Nodex should maintain two conceptual meshes:

### 1. Metadata mesh

Purpose:

- announce available keys/versions;
- announce invalidations;
- propagate freshness metadata;
- maintain peer/topology knowledge.

Characteristics:

- broader than payload mesh;
- low payload size;
- can tolerate probabilistic redundancy;
- uses digests, Bloom filters, version vectors, or compact summaries.

### 2. Payload mesh

Purpose:

- transfer actual cached objects or blocks;
- serve peer reads when policy allows.

Characteristics:

- sparse;
- interest-driven;
- cost-aware;
- limited by browser CPU/bandwidth/storage budget.

## Message types

### INTEREST

Peer declares it may want a key, namespace, tag, topic, or query class.

```json
{
  "type": "INTEREST",
  "peerId": "p1",
  "topics": ["product:price", "catalog:public"],
  "keys": ["product:123"],
  "ttlMs": 30000,
  "maxStaleness": { "versions": 2, "ms": 5000 }
}
```

### IHAVE

Peer announces inventory/version metadata without payload.

```json
{
  "type": "IHAVE",
  "peerId": "p2",
  "items": [
    { "key": "product:123", "version": 7, "hash": "sha256:..." }
  ]
}
```

### IWANT

Peer requests a specific key/version/block after seeing metadata.

```json
{
  "type": "IWANT",
  "key": "product:123",
  "minVersion": 7,
  "maxStaleMs": 5000
}
```

### PAYLOAD

Peer transfers the object or block.

### INVALIDATE

Server-originated or policy-authorized freshness signal.

```json
{
  "type": "INVALIDATE",
  "key": "product:123",
  "newVersion": 8,
  "issuedAt": "2026-06-02T12:00:00Z",
  "signature": "server-signature"
}
```

### PRUNE / GRAFT

Topology maintenance messages inspired by gossipsub:

- `GRAFT`: add peer to payload-capable mesh for a topic/key class;
- `PRUNE`: remove peer from payload mesh when not useful or too costly.

## Fan-out policy

Fan-out should not be static. Candidate inputs:

- number of interested peers for the key/topic;
- object volatility;
- stale budget;
- peer reliability;
- peer bandwidth/CPU budget;
- direct WebRTC success probability;
- whether peer path requires relay/TURN;
- key popularity.

Suggested first heuristic:

```text
fanout = clamp(
  base + popularityFactor + urgencyFactor - costPenalty - relayPenalty,
  minFanout,
  maxFanout
)
```

Where:

- `popularityFactor`: more peers recently requested this key/topic;
- `urgencyFactor`: bounded staleness window is short or invalidation is critical;
- `costPenalty`: peer has high latency/low bandwidth/high CPU;
- `relayPenalty`: connection is not direct and consumes relay/server egress.

## Interest and inventory state

Each peer maintains:

```text
interestTable[topic/key] -> peers interested + expiry
inventoryTable[key] -> peers claiming versions + hash + expiry
observedVersion[key] -> highest known version
peerScore[peerId] -> reliability/directness/cost
```

Entries must expire. Browser peers churn constantly; stale topology information is dangerous.

## Propagation logic

### On read miss

1. Check local cache.
2. If missing/stale, broadcast `INTEREST` or query metadata mesh.
3. Receive `IHAVE` candidates.
4. Select best peer by version, latency, direct connection, score, and cost.
5. Send `IWANT`.
6. Validate `PAYLOAD` metadata/hash/policy.
7. Serve if valid; otherwise fallback.

### On server update

1. Server increments canonical version.
2. Server issues signed `INVALIDATE` to seeds / known active peers.
3. Peers update observed metadata.
4. Peers gossip `INVALIDATE` through metadata mesh.
5. Payload is not pushed to everyone by default.
6. Interested peers pull new payload on demand.

This avoids flood-all updates.

## Safety rules

- Payload transfer must never override server policy.
- Invalidations should be server-signed or otherwise authenticity-protected.
- Peers with invalid hashes are downgraded or banned.
- Sensitive/personal data is not eligible.
- If the metadata path says a newer version exists but payload is unavailable, the read either waits, falls back, or serves with explicit staleness policy depending on data class.

## Research contribution candidate

A possible contribution is:

> A browser-constrained selective gossip algorithm that separates metadata propagation from payload transfer and adapts fan-out by interest, freshness budget, and connectivity cost.

This is stronger than claiming novelty from gossip alone.

## Evaluation targets

Measure:

- metadata bytes per useful payload;
- redundant IHAVE/IWANT/PAYLOAD messages;
- convergence delay for invalidations;
- stale-read violations;
- server offload;
- direct vs relay path ratio;
- behavior under churn and tab suspension;
- quality of fan-out choices.
