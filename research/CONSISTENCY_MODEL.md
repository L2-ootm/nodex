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

## Formal Correctness Conditions

The four invariants below constitute the formal consistency contract for Nodex. Each invariant is stated as a condition on admitted reads or accepted writes. Each has a corresponding implementation path in `src/shared/consistency.ts` via `admitCandidate()` and `observeVersion()`.

---

### Invariant 1: Session Consistency (Read Your Writes)

**Statement:** For any write W on key k in session S, every subsequent read R in session S on key k must return a version ≥ version(W).

**Assumptions:**
- The session has imported the server's AES-GCM session key before any reads.
- The write was accepted by the server (received a 200 response with `version` field).
- The session is bounded by a single SW lifetime; a SW restart resets obs_s.

**Implementation note:** `observedVersionMap.set(key, observeVersion(prev, returnedVersion))` is called after every admitted read. The `observeVersion()` function (`src/shared/consistency.ts`) returns `Math.max(previous, returned)`, ensuring obs_s(k) is monotonically non-decreasing. Any subsequent candidate with `version < obs_s(k)` is rejected by `admitCandidate()` with reason `below-session-observed`.

**Worked Example:**
- Session observes product /api/products/1 at version 3 (obs_s = 3).
- Client writes to /api/products/1 with baseVersion=3; server accepts, returns version 4.
- obs_s updated to 4 after write acknowledgment.
- A peer response arrives with version 3. `admitCandidate({ candidate.version: 3, sessionObservedVersion: 4 })` → `{ admitted: false, reason: 'below-session-observed' }`. Read falls back to server.
- Server returns version 4. `admitCandidate({ candidate.version: 4, sessionObservedVersion: 4 })` → `{ admitted: true }`. obs_s remains 4.

---

### Invariant 2: Monotonic Reads

**Statement:** For any two reads R1, R2 in session S on the same key k, if R1 precedes R2, then version(R2) ≥ version(R1).

**Assumptions:**
- Both reads resolve through `admitCandidate()` (cache hit path or peer-fetch path in sw.ts).
- The session has not restarted (SW has not been terminated and re-registered).

**Implementation note:** obs_s(k) is updated via `observeVersion(prev, returned) = Math.max(prev, returned)` after each admitted read. The check `candidate.version < sessionObservedVersion` in `admitCandidate()` (rejection reason: `below-session-observed`) enforces that no future read admits a version lower than the current obs_s(k). IDB persistence of obs_s entries (using `__obs_v:{key}` sentinels in `nodex-meta`) ensures continuity across page reloads within the same SW lifetime.

**Worked Example:**
- R1: SW serves /api/products/2 at version 5. obs_s updated: observeVersion(0, 5) = 5.
- R2 candidate: peer serves version 3. `admitCandidate({ version: 3, sessionObservedVersion: 5 })` → `{ admitted: false, reason: 'below-session-observed' }`. Peer candidate rejected.
- R2 resolved from server: version 7. `admitCandidate({ version: 7, sessionObservedVersion: 5 })` → `{ admitted: true }`. obs_s updated: observeVersion(5, 7) = 7.
- Version sequence: 5, 7 — monotonically non-decreasing. Invariant 2 satisfied.

---

### Invariant 3: Bounded-Staleness(K,T)

**Statement:** A candidate response for key k is admitted only if all three sub-conditions hold simultaneously:

1. `candidate.version ≥ lkv(k) − K`
2. `now − candidate.updatedAt ≤ T` (in milliseconds)
3. `candidate.version ≥ obs_s(k)`

Where K = maxStaleVersions (currently 2) and T = maxStaleMs (currently 5000 ms).

**Assumptions:**
- lkv(k) is the latest version of k known to the SW session (from seqMap, fed by gossip invalidations and server responses).
- candidate.updatedAt is a server-issued UTC timestamp in epoch milliseconds.
- The candidate's version and updatedAt are carried in X-Nodex-Version and X-Nodex-Updated-At response headers for server-originated responses.
- If lkv(k) is unknown (seqMap miss), lkv(k) is conservatively treated as candidate.version, making sub-condition 1 trivially satisfied. This is the cold-start case.

**Implementation note:** `admitCandidate()` in `src/shared/consistency.ts` checks sub-condition 3 first (`below-session-observed`), then sub-condition 1 (`beyond-version-staleness`: `candidate.version < latestKnownVersion - maxStaleVersions`), then sub-condition 2 (`beyond-time-staleness`: `now - candidate.updatedAt > maxStaleMs`). If any check fails, the candidate is rejected and the SW falls back to the server.

**Worked Example (version staleness):**
- Key /api/products/3: lkv = 10, K = 2.
- Peer response with version 7: 7 < 10 − 2 = 8 → `{ admitted: false, reason: 'beyond-version-staleness' }`.
- Peer response with version 9: 9 ≥ 10 − 2 = 8 → sub-condition 1 passes. Proceed to time check.

**Worked Example (time staleness):**
- Key /api/products/4: T = 5000 ms.
- Peer response with updatedAt = now − 6000: 6000 > 5000 → `{ admitted: false, reason: 'beyond-time-staleness' }`.
- Peer response with updatedAt = now − 3000: 3000 ≤ 5000 → sub-condition 2 passes.

---

### Invariant 4: OCC Write Rejection

**Statement:** A write operation W on key k carrying baseVersion B is rejected by the server if the server's current version of k (currentVersion) satisfies: `currentVersion > B`.

The server accepts the write and advances the version to `currentVersion + 1` only when: `currentVersion ≤ B`.

**Assumptions:**
- The server is the sole authority for canonical version assignment (authority model: server-side writes only).
- currentVersion is derived from the server's in-memory `seqCounters` map (initialized to 1 for unread keys).
- The client read the key at version B before constructing the write request.

**Implementation note:** `POST /api/write/:path` in `src/server/mock-api.ts` reads `seqCounters.get(path) ?? 1` as currentVersion. If `currentVersion > baseVersion`, returns HTTP 409 with body `{ error: 'conflict', currentVersion, baseVersion }`. Otherwise, calls `seqCounters.set(path, currentVersion + 1)` and returns HTTP 200 with `{ version: currentVersion + 1, path }`.

**Worked Example:**
- Server state: /api/products/5 at version 3.
- Client A reads at version 3, constructs write with baseVersion=3. Server processes: 3 ≤ 3 → accept, version advances to 4. Response: `200 { version: 4 }`.
- Client B (concurrent, also read at version 3) sends write with baseVersion=3. Server now at version 4: 4 > 3 → reject. Response: `409 { error: 'conflict', currentVersion: 4, baseVersion: 3 }`. Client B must re-read at version 4 before retrying.
- This prevents the double-write race condition identified in the Prof. Paulo meeting.

---

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
