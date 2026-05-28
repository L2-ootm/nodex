# Security Hardening Design — Nodex Beta
**Date:** 2026-05-28
**Scope:** Beta hardening (A) + production security architecture documentation (B)
**Status:** Approved

---

## Problem Statement

Three live security surfaces exist on the deployed beta:

1. `/api/session-key` and `/api/gossip-seed` are unauthenticated — any caller can retrieve the AES-GCM encryption key or trigger cache-wide evictions
2. TURN credentials (`openrelayproject`/`openrelayproject`) are compiled into the JS bundle — readable by anyone who inspects the source
3. No rate limiting — all API routes are open to flood attacks

Beta testers Natanny and Francisco use real browsers on real networks (4G/5G possible). All three surfaces are exploitable today.

---

## Design

Three independent layers. Each closes one surface. Each fails gracefully without taking down the others.

---

### Layer 1 — Edge Rate Limiting

**File:** `middleware.ts` (project root, Vercel edge runtime)

IP-based sliding window counter. Runs before any handler.

| Route group | Limit | Reasoning |
|-------------|-------|-----------|
| `/api/signal/*` | 120 req/min per IP | HTTP poll runs every 500ms = 120/min max; allows full speed + headroom |
| `/api/session-key`, `/api/turn-credentials` | 20 req/min per IP | Fetched once on page load, never in a hot loop |
| `/api/gossip-seed` | 10 req/min per IP | Server-to-server only; real usage ≈ 1 per test run |
| `/api/products/*` | unlimited | Cache read path — must never be throttled |

Response on breach: `429 Too Many Requests` with `Retry-After: 60` header.

**Backward compatibility:** Playwright tests run against localhost, not Vercel edge — unaffected. Beta testers at normal usage never approach any limit.

---

### Layer 2 — Endpoint Authentication

#### Shared token validator

Extract a single `validateBetaToken(req, role: 'tester' | 'admin')` helper. Reads `Authorization: Bearer <token>` header. Validates against `NODEX_BETA_TOKENS` (tester) or `NODEX_BETA_ADMIN_TOKENS` (admin) env vars. Returns `{ valid: boolean, role }`. Used by all gated endpoints.

#### `/api/session-key` — tester or admin token required

**Flow change:** The beta suite page holds the invite token at login. Rather than the SW fetching the key unauthenticated, the page fetches `/api/session-key` with `Authorization: Bearer <invite-token>` and pushes the key bytes to the SW via the existing `IMPORT_SESSION_KEY` postMessage.

The SW's `ensureSessionKey()` fallback remains but now receives a `401` → returns `502` gracefully. No SW code changes required.

```
Page (after login)
  → GET /api/session-key  [Bearer <invite-token>]
  → receives key bytes
  → postMessage({ type: 'IMPORT_SESSION_KEY', keyBytes }) to SW
  → SW stores key, ready to decrypt
```

#### `/api/turn-credentials` — tester or admin token required (new endpoint)

New endpoint added to `api/` Vercel functions. Returns the TURN server list with a 1-hour TTL. Credentials never appear in the bundle.

```
GET /api/turn-credentials
Authorization: Bearer <invite-token>

200 → { iceServers: IceServerConfig[], expiresAt: number }
401 → { error: 'unauthorized' }
429 → { error: 'rate limited' }
```

`p2p-manager.ts` fetches this at `init()` time, merges into `resolveNodexRuntimeConfig()`, passes to every `RTCPeerConnection`. Refresh: if a new peer connection is initiated within 5 minutes of `expiresAt`, fetch fresh credentials first.

Fallback chain:
```
fetch /api/turn-credentials
  ├─ 200  → STUN + TURN (full NAT traversal, 4G/5G compatible)
  ├─ 401  → STUN only, log warning
  └─ fail → STUN only, same behavior as pre-hardening
```

#### `/api/signal/gossip-seed` — admin token required

Called server-to-server only (invalidation handler → gossip seed). Add `Authorization: Bearer <NODEX_BETA_ADMIN_TOKEN>` to the internal call in `api/products/[id].ts` and `src/server/mock-api.ts`. Endpoint validates against `NODEX_BETA_ADMIN_TOKENS` env var.

No client-side changes required.

---

### Layer 3 — Dynamic TURN Credentials

**`src/shared/config.ts`:** Revert `ICE_SERVERS` to STUN-only. Remove all Open Relay entries.

```typescript
export const ICE_SERVERS: IceServerConfig[] = [
  { urls: 'stun:stun.l.google.com:19302' },
]
```

**`api/turn-credentials.ts`:** New Vercel function. Reads TURN credentials from env vars (`NODEX_TURN_URLS`, `NODEX_TURN_USERNAME`, `NODEX_TURN_CREDENTIAL`). Validates token. Returns `{ iceServers, expiresAt }`.

**`src/p2p/p2p-manager.ts`:** Add `fetchTurnCredentials(token)` call in `init()`. Store `turnCredentials` and `turnExpiresAt` at module level. Pass to `resolveNodexRuntimeConfig({ iceServers: turnCredentials })` when creating `RTCPeerConnection`.

**New env vars required (Vercel):**
```
NODEX_TURN_URLS=turn:openrelay.metered.ca:80,turn:openrelay.metered.ca:443,turns:openrelay.metered.ca:443
NODEX_TURN_USERNAME=openrelayproject
NODEX_TURN_CREDENTIAL=openrelayproject
```

These replace the hardcoded values that were in the bundle.

---

## Production Security Architecture (Documentation Target — B)

The following describes what a production deployment of Nodex should implement. This is the architecture the research paper cites — the beta implements the PoC shortcut with a documented upgrade path.

### Time-Limited TURN Credentials (coturn REST API model)

```
Server generates per-connection credentials:
  username  = floor(now/1000) + 3600 + ':' + nodeId   // expires in 1 hour
  credential = HMAC-SHA1(TURN_SECRET, username)

Client uses credentials for that connection only.
TURN server enforces expiry via the timestamp in username.
```

No static credential ever leaves the server. A leaked credential is valid for at most 1 hour.

### Per-Session AES-GCM Keys

```
Login → server issues session JWT (RS256, 30-min TTL)
Session JWT → exchanged for per-session AES-GCM key (non-extractable)
Key ID = sessionId (not 'default')
Key delivered over authenticated channel only
extractable: false on importKey call
```

Key rotation: new key issued on session refresh. Old key remains valid for in-flight requests for a 60-second overlap window.

### Authenticated Invalidation Channel

```
POST /api/invalidate/:path
  requires: signed JWT with role=origin
  validates: JWT signature, path ownership, rate limit

/api/gossip-seed
  internal only, not reachable from internet
  called via internal service-to-service auth (shared secret or mTLS)
```

### Signaling Authentication

```
POST /api/signal/join
  requires: session JWT
  nodeId bound to JWT subject — prevents impersonation

Peer connections: DTLS-SRTP (WebRTC default) provides transport auth
No additional peer identity layer needed for PoC scale
```

### Rate Limiting at Scale

```
Edge: IP-based (Vercel middleware, as in beta)
Application: per-token rate limit via Supabase rate_limits table
  → prevents a single compromised token from flooding the system
Circuit breaker: if gossip-seed receives >N messages/min from one origin, pause and alert
```

---

## Files Changed

| File | Change |
|------|--------|
| `middleware.ts` | New — edge rate limiting |
| `api/turn-credentials.ts` | New — dynamic TURN endpoint |
| `api/signal/[...path].ts` | Add token validation to `/gossip-seed` handler |
| `src/shared/config.ts` | Revert ICE_SERVERS to STUN-only |
| `src/p2p/p2p-manager.ts` | Add `fetchTurnCredentials()` in `init()`, credential refresh logic |
| `apps/beta-suite/` | Page fetches session key with Bearer token, pushes to SW via IMPORT_SESSION_KEY |
| `src/sw/sw.ts` | No changes required |
| Vercel env vars | Add `NODEX_TURN_URLS`, `NODEX_TURN_USERNAME`, `NODEX_TURN_CREDENTIAL` |

---

## Testing Plan

- [ ] Rate limiter: hit `/api/signal/poll` 121 times in 60s from same IP → expect 429 on 121st
- [ ] Session key: fetch `/api/session-key` with no token → expect 401; with valid tester token → expect 200
- [ ] Gossip seed: POST `/api/signal/gossip-seed` with no token → expect 401; with admin token → expect `{ seeded: true }`
- [ ] TURN credentials: fetch with valid token → expect `{ iceServers, expiresAt }`; bundle inspection → no `openrelay` string
- [ ] P2P connection: two browser contexts with valid tokens → WebRTC connects via TURN (verify via `selected_candidate_type: 'relay'` in metrics)
- [ ] Fallback: fetch TURN with expired token → p2p-manager falls back to STUN-only, connection still forms on local network

---

*Design approved: 2026-05-28*
