# Nodex — Formal System Model (G3)

## 1. Scope

This fixes the vocabulary for reasoning about Nodex precisely. It is implementation-agnostic: it states what exists and what the rules are, not how the code is structured. Every definition is labeled so downstream proofs can cite it.

## 2. Nodes and roles

The system is a set of nodes $P = P_b \cup P_f$.

- **Def. 2.1 (Ephemeral browser node, $P_b$).** A browser tab running Nodex. Subject to churn, tab suspension, NAT/CGNAT, and no inbound listening socket. Holds a partial cache and participates in the overlay opportunistically. Has **no write authority**.
- **Def. 2.2 (Fixed node, $P_f$).** A long-lived server-side process: origin/write authority, signaling server, and bootstrap/seed peers. Small in number, assumed reachable subject to normal availability. **Sole holder of write authority**.
- **Def. 2.3 (Active node).** A node currently connected to at least one peer or to a fixed node, and not suspended.

## 3. Keys, versions, payloads

- **Def. 3.1 (Key).** An application-level identifier $x$ for a cacheable object.
- **Def. 3.2 (Version).** A server-assigned, monotonically increasing label $v(x) \in \mathbb{N}$, realized as a durable LSN or `(epoch, counter)` pair. Only $P_f$ advances $v$.
- **Def. 3.3 (Payload).** The tuple $\rho = (x, v, hash, class, t_{upd}, ciphertext)$ where `hash` authenticates ciphertext, `class` is from Def. 6.1, and $t_{upd}$ is server commit time.
- **Def. 3.4 (Freshness / staleness).** For a read returning version $v_r$ when latest committed version is $v^*$, **version staleness** is $v^* - v_r$ and **time staleness** is `now - updatedAt(v_r)`.

## 4. Sessions and observed-version barrier

- **Def. 4.1 (Session).** A single browser context $s$ with a durable local store, persisting across reloads where the browser permits.
- **Def. 4.2 (Observed-version barrier).** For session $s$ and key $x$, $obs_s(x)$ is the maximum version of $x$ that $s$ has read or written. Initialized to `0`. It is monotonically non-decreasing by construction and makes session guarantees provable without a round-trip.

## 5. Operations

- **Def. 5.1 (`read(x)`).** Returns an admissible payload from local store → peer → server, in that preference order, updating $obs_s(x)$ to the returned version.
- **Def. 5.2 (`write(x, baseVersion)`).** Submitted to $P_f$ with the version the writer believes is current. $P_f$ commits iff `baseVersion = v(x)`; on success $v(x) \leftarrow v(x)+1$ and an `INVALIDATE` is published. On conflict the write is rejected and the client refetches.
- **Def. 5.3 (Invalidation).** A server-signed announcement `(x, v_new)` disseminated via the overlay; receiving it lets peers drop or down-rank stale copies of $x$.

## 6. Data classes

- **Def. 6.1 (Class).** A total function `class: Keys -> {critical, fresh-dynamic, session-owned, mergeable, cold-blob, forbidden}` assigned by the application schema. It selects the consistency policy. This typing is the core design contribution surface.

## 7. Overlay and network model

- **Def. 7.1 (Overlay).** A time-varying graph $G_t = (P_b \cup S, E_t)$ where $S$ are signaling/seed nodes and $E_t$ are live WebRTC data channels at time $t$.
- **Def. 7.2 (Two meshes).** A dense metadata mesh for digests/interest/invalidation/inventory, and a sparse payload mesh for full payloads.
- **Def. 7.3 (Edge realizability).** An edge `(a,b)` is realizable iff ICE produces a working candidate pair; otherwise communication uses TURN relay or a mutual intermediary. Edge classes: `host`, `srflx`, `relay`, `none`.
- **Def. 7.4 (Propagation function $P_w(c,t)$).** Probability that `c` replicas have received a given write by time `t` after commit; fitted from measured RTT distributions and consumed by PBS `<k,t>`.

## 8. Failure and churn model

- **Def. 8.1 (Churn event).** A node join or leave. Arrivals modeled as a Poisson process with rate $\lambda$; session lifetimes as exponential or Weibull.
- **Def. 8.2 (Suspension).** A browser tab frozen by OS/browser — state persists but the node is temporarily inert.
- **Def. 8.3 (Partition).** A maximal set of nodes mutually reachable in $G_t$. The presence of $P_f$ means there is always an authoritative anchor outside any browser-only partition.

## 9. Trust boundary

$P_f$ is trusted for write ordering and version signing. Browser peers are untrusted relays of authenticated ciphertext: they can withhold, delay, or replay, but cannot forge a higher version nor read plaintext.

## 10. Glossary

| Symbol | Meaning |
|---|---|
| $P_b$ / $P_f$ | ephemeral browser nodes / fixed nodes |
| $v(x)$ | server-assigned monotone version of key $x$ |
| $obs_s(x)$ | observed-version barrier for session $s$, key $x$ |
| `class(x)` | consistency class of key $x$ |
| $K, T$ | bounded-staleness budget: versions, time |
| $P_w(c,t)$ | propagation CDF used by PBS |
| $G_t$ | time-varying overlay graph |

**Status:** Canonical repo scaffold added from uploaded G3 formalization. Next implementation step: executable admission rule in `src/shared/consistency.ts`.
