---
title: "Nodex — Consistency Model"
date: 2026-06-02
status: draft-after-paulo-research
source: "Research-after-meeting.txt"
---

# Nodex — Consistency Model

## Purpose

This document defines the consistency model Nodex should pursue after the Prof. Paulo meeting and the follow-up research sprint.

Nodex must not promise universal strong consistency. The correct model is a **policy-based consistency stack** where each data class declares what freshness and conflict behavior it can tolerate.

## Definitions

The following terms are used precisely in the formal invariants below. Definitions map to implementation types in `src/shared/consistency.ts` and related modules.

- **Session**: A browser-side lifecycle unit bounded by Service Worker registration and restart. Equivalent to the SW module execution context. Resets on SW update or termination.
- **Read**: A GET request intercepted by the Service Worker that resolves to a versioned payload (from cache, peer, or server).
- **Version**: A server-issued monotonic integer assigned to each write of a key. Version N supersedes version N-1. Never decremented.
- **Observed version barrier (obs_s(k))**: The maximum version of key k observed by this session across all reads. Maintained in `observedVersionMap: Map<string, number>` in `src/sw/sw.ts`. Initial value: 0 (no version observed yet).
- **Staleness window — versions (K)**: The maximum number of versions a candidate response may lag behind the latest known version. Configured as `maxStaleVersions` in `ConsistencyPolicy` (`src/shared/consistency.ts`). Current value: 2 (set in `peerReadsPolicyFromScore()`).
- **Staleness window — time (T)**: The maximum wall-clock age (in milliseconds) of a candidate response measured from its server-issued `updatedAt` timestamp. Configured as `maxStaleMs` in `ConsistencyPolicy`. Current value: 5000 ms (5 seconds), delivered as `X-Nodex-Max-Stale-Ms` response header.
- **Write epoch**: The server-side version counter value at the moment a write is accepted. A write carrying `baseVersion` is accepted if and only if `baseVersion >= currentVersion` at the moment the server processes it. Implemented via `seqCounters` in `src/server/mock-api.ts`.
- **Latest known version (lkv(k))**: The most recent server-issued version of key k known to this session. Derived from gossip invalidation messages and direct server responses. Stored in the in-memory seqMap (`src/sw/freshness.ts`).

## Non-goals

Nodex does not attempt to provide:

- linearizability for all reads;
- latest-value guarantee without contacting a trusted source;
- decentralized writes;
- peer authority over truth;
- MSI/MESI-style hardware cache coherence;
- suitability for all dynamic data.

## Authority model

### Server authority

The server remains authoritative for:

- writes;
- canonical version creation;
- policy definition;
- invalidation source;
- fallback reads;
- conflict rejection;
- access control decisions.

### Peer role

Browser peers may:

- cache eligible payloads;
- advertise inventory and version metadata;
- serve opaque or authorized payloads to eligible peers;
- propagate invalidation/freshness metadata;
- request missing payloads/blocks from peers.

Browser peers must not:

- decide canonical truth;
- accept writes as final;
- override server policy;
- serve sensitive or personalized data unless explicitly allowed by policy.

## Data classes

| Class | Example | Nodex policy | Notes |
|---|---|---|---|
| Critical transactional | inventory purchase, payment, booking slot | server-only latest validation; no peer-authoritative read for write decision | Cache may display, but write must validate base version |
| Fresh dynamic read | product price, availability badge, feed item | bounded-staleness(K,T) + fallback | Must show staleness budget |
| Session-owned data | user's own draft/state | session consistency / read-your-writes | Browser can guarantee only what it has observed/written |
| Mergeable collaborative | sets, maps, comments, collaborative structures | CRDT / strong eventual consistency | Only for naturally mergeable objects |
| Large/cold payload | media fragments, static-ish documents | block/hash pull on demand | Inspired by WebTorrent/Syncthing |
| Sensitive/personalized | secrets, private account data, auth data | prohibited from peer distribution | Server/CDN only |

## Recommended guarantees

### 1. Read-your-writes

A browser must never read a version older than one it locally wrote or observed as committed.

Implementation implication:

- maintain a session token or observed version barrier;
- local reads must compare candidate peer/cache version against the session barrier;
- if candidate is older, reject and fallback.

### 2. Monotonic reads

If a browser has observed version `v7`, it must not later accept version `v5` for the same key.

Implementation implication:

- maintain `maxObservedVersionByKey` or equivalent;
- peer payloads older than local observed version are invalid;
- metadata-only gossip can advance observed invalidation state even before payload is fetched.

### 3. Bounded staleness

Eligible objects declare a maximum staleness budget:

- `K`: maximum versions behind;
- `T`: maximum wall-clock duration behind;
- or both, whichever is stricter.

A peer/cache response is acceptable only if:

```text
candidate.version >= latestKnownVersion - K
AND now - candidate.updatedAt <= T
AND candidate.version >= sessionObservedVersion
```

Important: this does not guarantee global latest value unless the latest version is already known. It defines a policy based on known metadata and server-issued timestamps/versions.

### 4. Strong eventual consistency for CRDT objects

For mergeable objects, Nodex may use CRDT semantics:

- commutative;
- associative;
- idempotent merge;
- convergence if updates are eventually delivered.

This applies only where domain semantics support deterministic merge.

### 5. Best-effort eventual consistency

Low-risk data may accept eventual convergence without tight bound.

Use only when stale reads are operationally safe.

## Write path: optimistic concurrency

Every write based on a previously read value must include a base version.

Example:

```json
{
  "key": "product:123:stock",
  "baseVersion": 5,
  "operation": "reserve",
  "payload": { "quantity": 1 }
}
```

Server behavior:

- accept only if current server version is still compatible with `baseVersion`;
- reject if current version has advanced and operation is no longer safe;
- return conflict metadata to client.

This directly addresses the race condition raised by Prof. Paulo.

## Metadata model

Minimum metadata for peer/cache payloads:

```json
{
  "key": "namespace:item",
  "version": 7,
  "updatedAt": "2026-06-02T12:00:00Z",
  "policy": "bounded-staleness",
  "maxStaleVersions": 2,
  "maxStaleMs": 5000,
  "etag": "...",
  "contentHash": "sha256:...",
  "scope": "public-or-authorized-group",
  "expiresAt": "2026-06-02T12:00:05Z"
}
```

## Fallback rules

Fallback to server is mandatory when:

- metadata is missing;
- version is older than session barrier;
- staleness budget is exceeded;
- integrity/hash check fails;
- access scope is unclear;
- peer path times out;
- key class is server-only;
- write decision requires latest state.

## Claims allowed

Allowed:

> Nodex can reduce server read pressure for eligible dynamic data under explicit staleness and session guarantees.

Allowed:

> Nodex uses server-authoritative writes with optimistic concurrency while allowing browser peers to assist safe reads.

Not allowed:

> Nodex guarantees the latest value without server validation.

Not allowed:

> Nodex solves all dynamic caching problems.
