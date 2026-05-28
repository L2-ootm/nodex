# Nodex Security Reference

**Last updated:** 2026-05-28  
**Scope:** Beta deployment security hardening + production security architecture target

---

## 1. Overview

Nodex is a browser-native P2P distributed cache. Its security surface is unusual: the browser page, Service Worker, and WebRTC peer all run in untrusted client environments. The server's role is reduced to key issuance, signaling, and gossip seeding — which makes server-side API security the only reliable enforcement boundary.

### Threat Model Summary

| Threat | Impact | Mitigated In |
|--------|--------|--------------|
| Unauthenticated key fetch | Attacker obtains AES-GCM key, can decrypt all cached content | Beta: Bearer token; Prod: session JWT |
| Unauthenticated gossip trigger | Attacker forces cache-wide invalidation, causing origin load spike | Beta: Bearer token; Prod: signed JWT with origin role |
| Static TURN credentials in bundle | Attacker inspects JS bundle, relays arbitrary WebRTC traffic through TURN server | Beta: runtime fetch; Prod: time-limited HMAC credentials |
| Flood attacks on signaling/key endpoints | DoS on signaling breaks peer discovery; flood on session-key exhausts issuance budget | Beta: edge rate limiter; Prod: per-token application-layer limits |
| Credential replay | TURN credentials reused after session ends | Beta: 1h TTL; Prod: coturn HMAC model, 1h max |
| Node impersonation in signaling | Rogue node joins under another node's identity | Beta: token-gated join; Prod: nodeId bound to JWT subject |

### What Was Open Before 2026-05-28

Three surfaces were unprotected in the initial PoC deployment:

1. `/api/session-key` — returned AES-GCM-256 key bytes to any unauthenticated caller.
2. `/api/signal/gossip-seed` — triggered network-wide cache invalidation with no authentication.
3. TURN relay credentials (openrelay.metered.ca username/password) were hardcoded in `src/shared/config.ts` and compiled into the `p2p-manager` bundle, readable by anyone with browser DevTools.

All three are closed as of 2026-05-28. The sections below document exactly how.

---

## 2. Beta Security Implementation

The beta uses three independent enforcement layers. They are not redundant — each layer defends a different attack surface.

### Layer 1 — Bearer Token Authentication (`api/lib/auth.ts`)

All sensitive endpoints now require a valid bearer token. The shared validator is in `api/lib/auth.ts`:

```typescript
export type BetaTokenRole = 'tester' | 'admin'

export function validateBetaToken(req: Request, role: BetaTokenRole): boolean
export function unauthorizedResponse(): Response  // returns 401 JSON
```

**Validation logic:**
- Extract `Authorization: Bearer <token>` header.
- Tokens are compared against two env var lists: `NODEX_BETA_TOKENS` (tester-role) and `NODEX_BETA_ADMIN_TOKENS` (admin-role).
- Admin tokens pass any role check. Tester tokens pass only `'tester'` role checks.
- No database lookup — tokens are in-memory at request time from Vercel env vars.

**Endpoints protected by auth:**

| Endpoint | Required Role | Method |
|----------|--------------|--------|
| `GET /api/session-key` | `tester` | `api/session-key.ts` |
| `GET /api/turn-credentials` | `tester` | `api/turn-credentials.ts` |
| `POST /api/signal/gossip-seed` | `admin` | `api/signal/[...path].ts` |

Request flow for a protected endpoint:

```
Client                          Vercel Function
  |                                   |
  | GET /api/session-key              |
  | Authorization: Bearer nodex-tester-<32hex>
  |---------------------------------->|
  |                    validateBetaToken(req, 'tester')
  |                    parse NODEX_BETA_TOKENS env
  |                    compare token strings
  |                    match found → continue
  |                                   |
  |        { keyBytes: <base64> }     |
  |<----------------------------------|
```

If the token is missing or invalid:

```
  |<--  401 { error: "Unauthorized" } |
```

### Layer 2 — Edge Rate Limiter (`apps/beta-suite/middleware.ts`)

Rate limiting runs in Vercel Next.js edge middleware, before any Vercel function is invoked. It uses a per-IP sliding window that resets every 60 seconds.

**Route groups and limits:**

| Route pattern | Limit | Window |
|---------------|-------|--------|
| `/api/signal/*` | 120 req/min | 60s sliding |
| `/api/session-key` | 20 req/min | 60s sliding |
| `/api/turn-credentials` | 20 req/min | 60s sliding |
| `/api/products/*` | unlimited | — |

On breach, the middleware returns:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
Content-Type: application/json

{ "error": "Rate limit exceeded" }
```

The rate state is in-memory within each edge runtime instance. Because Vercel edge runs distributed, this provides best-effort rate limiting rather than a hard global cap. It is sufficient to prevent accidental flooding and naive DoS from a single IP; production requires a distributed counter (see Section 7).

### Layer 3 — STUN-Only Default Config (`src/shared/config.ts`)

Before this fix, `ICE_SERVERS` in `src/shared/config.ts` included hardcoded TURN credentials:

```typescript
// BEFORE (insecure — credential visible in bundle)
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
]
```

After the fix:

```typescript
// AFTER (secure — STUN only; TURN obtained at runtime via /api/turn-credentials)
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' }
]
```

TURN credentials are fetched at runtime and merged into the peer connection config. The bundle contains no credentials.

---

## 3. Token System

### Token Format

Tokens are opaque strings with a structured prefix for human readability. They are not JWTs — there is no signature verification, only string equality against env var lists.

```
nodex-tester-<32 hex chars>     # tester-role token
nodex-admin-<32 hex chars>      # admin-role token
```

Examples:
```
nodex-tester-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
nodex-admin-f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3
```

### Env Var Format

Tokens are stored in Vercel environment variables. Do not commit these to source control.

**`NODEX_BETA_TOKENS`** — pipe-delimited per entry, comma between entries:

```
nodex-tester-<32hex>|<Name>||<WelcomeNote>,nodex-tester-<32hex>|<Name>||<WelcomeNote>
```

Field layout per entry (pipe-separated):
1. Token string
2. Tester name (display only, not used in validation)
3. Reserved (empty)
4. Welcome note (display only)

**`NODEX_BETA_ADMIN_TOKENS`** — comma-separated list of admin token strings:

```
nodex-admin-<32hex>,nodex-admin-<32hex>
```

### Role Semantics

| Role | Grants access to |
|------|-----------------|
| `tester` | `GET /api/session-key`, `GET /api/turn-credentials` |
| `admin` | All tester endpoints + `POST /api/signal/gossip-seed` + any future `admin`-gated endpoints |

An admin token passes a `validateBetaToken(req, 'tester')` check. A tester token fails a `validateBetaToken(req, 'admin')` check.

### Token Distribution

Tokens are distributed out-of-band (email, DM) to beta testers. The beta suite injects the token into the runtime iframe URL as a query parameter (`nodexBetaToken`). This is a documented PoC shortcut — see Section 8 for the production replacement.

---

## 4. TURN Credential Lifecycle

### The Old Problem

Hardcoded TURN credentials in the JS bundle are accessible to any visitor via browser DevTools → Sources. Anyone with the credential can relay arbitrary WebRTC traffic through the TURN server, exhausting the free-tier quota and potentially exposing traffic patterns.

### The New Flow

TURN credentials are fetched at runtime, bound to a session, and expired server-side.

```
Page Load
  |
  | p2p-manager.init(runtimeConfig)
  |   1. Read nodexBetaToken from URL params
  |   2. Call fetchTurnCredentials(apiOrigin, token)
  |       GET /api/turn-credentials
  |       Authorization: Bearer <token>
  |       <-- { iceServers: [...], expiresAt: <unix_ms> }
  |   3. Merge returned iceServers into runtimeConfig.iceServers
  |   4. Proceed with RTCPeerConnection using merged config
  |
  | connectToPeer(peerId)
  |   - RTCPeerConnection({ iceServers: mergedServers })
  |   - If now > expiresAt - 5min: re-fetch turn-credentials
```

### `/api/turn-credentials` Response Shape

```typescript
interface TurnCredentialsResponse {
  iceServers: RTCIceServer[]  // STUN + TURN entries
  expiresAt: number           // Unix timestamp ms, now + 3600000
}
```

Example response:
```json
{
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    {
      "urls": ["turn:openrelay.metered.ca:443?transport=tcp"],
      "username": "...",
      "credential": "..."
    }
  ],
  "expiresAt": 1748476800000
}
```

### Credential Env Vars

The endpoint reads TURN config from Vercel env vars at request time:

| Env Var | Value |
|---------|-------|
| `NODEX_TURN_URLS` | Comma-separated TURN URL strings |
| `NODEX_TURN_USERNAME` | TURN username |
| `NODEX_TURN_CREDENTIAL` | TURN credential (password or HMAC) |

If any of these are unset, the endpoint falls back to STUN-only and returns no TURN entry. The p2p connection still works for local/same-NAT peers; only cross-NAT relay is unavailable.

### 5-Minute Refresh Guard

`p2p-manager.ts` tracks `turnCredentialsExpiry`. In `connectToPeer()`, before creating a new `RTCPeerConnection`:

```
if (Date.now() > turnCredentialsExpiry - 300_000) {
  await fetchTurnCredentials(apiOrigin, token)
}
```

This prevents a peer connection from being created with expired TURN credentials when a long-lived page crosses the 1-hour boundary.

---

## 5. Session Key Delivery

### The Flow

The AES-GCM-256 session key must reach the Service Worker without being stored in the page's accessible JS scope after import. The delivery path is:

```
Page (p2p-manager.ts)                  Service Worker (sw.ts)
  |                                           |
  | 1. GET /api/session-key                  |
  |    Authorization: Bearer <token>         |
  |    <-- { keyBytes: <base64> }            |
  |                                           |
  | 2. navigator.serviceWorker.controller    |
  |    .postMessage({                        |
  |      type: 'IMPORT_SESSION_KEY',         |
  |      keyBytes: <base64>                  |
  |    })                                    |
  |----------------------------------------->|
  |                  3. sw.ts receives message
  |                     crypto.subtle.importKey(
  |                       'raw', decoded,
  |                       { name: 'AES-GCM' },
  |                       false,  // extractable: false in prod
  |                       ['encrypt', 'decrypt']
  |                     )
  |                     Store as module-scope CryptoKey
  |                                           |
  | (keyBytes string is now GC-eligible)     |
```

### `/api/session-key` Response Shape

```typescript
interface SessionKeyResponse {
  keyBytes: string  // base64-encoded 32-byte AES-GCM-256 key
}
```

### Key Usage in Service Worker

Once the key is imported, the SW uses it for all decrypt operations on cache hits:

```
SW fetch handler receives request
  |
  | cache.match(request)
  |   found → decrypt(ciphertext, sessionKey)
  |   return plaintext Response
  |
  | not found → fetch from origin, encrypt, cache.put, return
```

The key lives as a module-scope `CryptoKey` in the SW global. It is never postMessaged back to the page.

### Beta vs Production Extractability

In the beta, the key is imported with `extractable: true`. This is a PoC shortcut that allows key inspection during debugging. In production, `extractable: false` must be enforced — once imported, the key material cannot be exported from the SW context even via a compromised page script.

---

## 6. Rate Limiter Behaviour

### Implementation

The rate limiter is a Vercel Next.js edge middleware (`apps/beta-suite/middleware.ts`). It executes on the edge before any origin function handles the request.

### Per-IP Sliding Window

Each IP gets an independent counter per route group. The counter resets at 60-second boundaries.

Implementation detail: The in-memory `Map<string, { count: number, resetAt: number }>` is keyed by `"${ip}:${routeGroup}"`. On each request:

1. If `Date.now() > resetAt`: reset count to 0, set `resetAt = Date.now() + 60_000`.
2. Increment count.
3. If count exceeds limit: return 429.

### Limits Table

| Route group | Pattern match | Limit |
|-------------|--------------|-------|
| `signal` | `/api/signal/` prefix | 120 req/min |
| `key` | `/api/session-key` exact | 20 req/min |
| `turn` | `/api/turn-credentials` exact | 20 req/min |
| `products` | `/api/products/` prefix | unlimited |

Routes that match no group: unlimited (pass-through).

### 429 Response

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
Content-Type: application/json

{"error":"Rate limit exceeded"}
```

The client must wait until the `Retry-After` window elapses before retrying. The p2p-manager and beta suite do not currently implement automatic retry on 429 — this is a known beta limitation (see Section 8).

### Edge Distribution Caveat

Vercel's edge network runs the middleware across multiple PoPs. The in-memory counter is not shared across PoPs. A single IP hitting different PoPs in the same 60-second window could theoretically exceed the stated limit by a factor of the number of active PoPs. This is acceptable for beta; production requires a Redis- or Supabase-backed distributed counter (see Section 7).

---

## 7. Production Upgrade Path

This section documents what the beta implements as a PoC approximation and what must be replaced before production deployment. This is the architecture described in the Nodex research paper.

### 7.1 Time-Limited TURN Credentials (coturn HMAC model)

**Beta:** Static credentials stored in Vercel env vars, returned as-is with a 1-hour TTL set by the server.

**Production:** Use the [coturn REST API credential model](https://github.com/coturn/coturn/wiki/TURN-REST-API):

```
username = floor(now / 1000) + 3600 + ':' + nodeId
           └─ expiry unix timestamp ─┘   └─ identity ┘

credential = base64(HMAC-SHA1(TURN_SECRET, username))
```

- `TURN_SECRET` never leaves the server.
- Each credential is valid for exactly 1 hour from issuance.
- The TURN server validates the HMAC independently — no server-to-TURN communication needed per request.
- A leaked credential is usable only until `floor(username.split(':')[0]) * 1000` elapses.

The `/api/turn-credentials` endpoint constructs the username and credential using this algorithm. `TURN_SECRET` is a Vercel secret (not an env var readable by client code).

### 7.2 Per-Session AES-GCM Keys

**Beta:** Single key per deployment, `extractable: true`, key ID is `'default'`.

**Production:**

1. User authenticates → server issues session JWT (RS256, 30-min TTL). JWT subject = `userId`, JWT ID = `sessionId`.
2. Page exchanges session JWT for a per-session AES-GCM-256 key: `POST /api/session-key` with `Authorization: Bearer <jwt>`.
3. Server generates a fresh 32-byte key per `sessionId`, stores `{ sessionId → keyHash }` in Supabase for audit, returns key bytes.
4. SW imports with `extractable: false`. Key ID in SW storage = `sessionId`, not `'default'`.
5. On session refresh (new JWT issued): server generates new key. Old key remains valid for a 60-second overlap window to cover in-flight requests. After 60 seconds, SW discards the old key.
6. Key material is never logged, never stored server-side (only a hash for audit), never re-exported from SW.

### 7.3 Authenticated Invalidation Channel

**Beta:** `POST /api/signal/gossip-seed` requires admin bearer token. Any admin token holder can trigger cache-wide invalidation.

**Production:**

- `POST /api/invalidate/:path` is the public-facing endpoint. It requires a signed JWT with `{ role: 'origin' }` claim, issued to trusted origin services only.
- `/api/signal/gossip-seed` is an internal endpoint. It is not reachable from the public internet. Origin services call it via internal service-to-service auth: either a shared secret (`INTERNAL_SERVICE_TOKEN` env var, rotated regularly) or mTLS.
- The gossip-seed handler verifies: (a) internal service token, (b) `sourceOrigin` field in the payload matches a whitelist of known origin service identifiers.

### 7.4 Signaling Authentication

**Beta:** `POST /api/signal/join` is token-gated but does not bind node identity to the token. Any valid tester token can join with any self-declared `nodeId`.

**Production:**

- `POST /api/signal/join` requires session JWT.
- `nodeId` in the join request must equal `sub` (subject) of the JWT. Server enforces this before emitting the join event to the room.
- DTLS-SRTP (standard WebRTC) handles transport-layer authentication between peers. The signaling server authenticates join but not individual data channel messages — DTLS handles that.
- Node identity is cryptographically bound: a rogue node cannot impersonate another node's `nodeId` without the corresponding session JWT.

### 7.5 Rate Limiting at Scale

**Beta:** In-memory per-PoP edge middleware, not globally consistent.

**Production — three tiers:**

**Tier 1 — Edge (IP-based):**  
Identical to beta middleware but backed by a Vercel KV (Redis-compatible) store for global consistency across PoPs. Same limits apply; counters are globally consistent.

**Tier 2 — Application (per-token):**  
Each token gets a row in Supabase `rate_limits` table:
```sql
rate_limits(token_hash TEXT, route_group TEXT, count INT, reset_at TIMESTAMPTZ)
```
The Vercel function increments the counter inside a Supabase transaction. Limits are tighter than edge limits to prevent one token from dominating.

**Tier 3 — Circuit breaker (gossip-seed):**  
If `POST /api/signal/gossip-seed` receives more than `N` messages per minute from a single origin service, the handler:
1. Pauses gossip propagation for that origin.
2. Logs an alert to Supabase `security_events`.
3. Returns 503 with `Retry-After`.

This prevents a misconfigured origin from triggering a cache stampede across all active peers.

---

## 8. Known Beta Limitations

These are documented PoC shortcuts that are acceptable for a research/beta context but must be addressed before production deployment.

| Limitation | Impact | Production Fix |
|------------|--------|----------------|
| `extractable: true` on AES-GCM key import in SW | Key material can be exported from the SW context via `subtle.exportKey` | Import with `extractable: false`; no code path should need to re-export the key |
| Single shared key across all beta sessions | All testers share one key; a compromised tester token exposes all cached content | Per-session keys bound to session JWT (Section 7.2) |
| Bearer tokens as plain strings in URL params | `nodexBetaToken` appears in browser history, server logs, and referrer headers | Replace with short-lived session JWT delivered via secure `HttpOnly` cookie or Authorization header only |
| Tokens in URL params logged by Vercel | Vercel logs request URLs; tokens in query params are logged in plaintext | Move token to `Authorization` header for all requests; never put tokens in URLs |
| In-memory rate limiter not globally consistent | Per-PoP counters allow higher effective rate than documented limits | Vercel KV-backed global counter (Section 7.5) |
| No retry logic on 429 | If the edge rate limiter fires, the p2p-manager fails silently; no automatic backoff | Implement exponential backoff with jitter on 429 responses |
| Static TURN credentials from env var (not HMAC-generated) | Leaked credentials valid until manually rotated | coturn HMAC model with per-connection short-lived credentials (Section 7.1) |
| Admin token controls gossip-seed with no audit log | Gossip triggers are not logged; no way to audit which admin triggered invalidation | Log all gossip-seed calls to Supabase `invalidation_log` with token hash and timestamp |
| No token revocation mechanism | Compromised tokens remain valid until env var is updated and Vercel redeployed | Token revocation table in Supabase; validator checks revocation list on each request |
| `nodeId` not bound to token in signaling | Any valid tester token can join with any self-declared `nodeId` | Bind `nodeId` to JWT subject on join (Section 7.4) |
| TURN credential expiry not enforced by relay | openrelay.metered.ca does not enforce coturn HMAC expiry model | Deploy own coturn instance with HMAC REST API or use a provider that supports it |

---

## Appendix: Deployment Architecture

```
Browser Page (untrusted)
  |
  | HTTPS
  |
  +-- apps/beta-suite (Next.js, Vercel)
  |     middleware.ts (edge rate limiter)
  |     next.config.mjs (rewrites /api/* → nodex-beta-api.vercel.app)
  |     components/TesterPages.tsx (injects nodexBetaToken into iframe URL)
  |
  | rewrite proxy
  |
  +-- nodex-beta-api (Hono, Vercel Functions)
        api/lib/auth.ts (token validator)
        api/session-key.ts (AES key issuance)
        api/turn-credentials.ts (TURN credential issuance)
        api/signal/[...path].ts (signaling + gossip-seed)
        api/products/*.ts (mock origin data)

Browser Service Worker (untrusted, isolated scope)
  |
  | postMessage (IMPORT_SESSION_KEY)
  | received from page after key fetch
  |
  +-- CryptoKey (module-scope, not extractable in prod)
        used for encrypt/decrypt on cache read/write

Browser Page Thread
  |
  +-- p2p-manager.ts
        RTCPeerConnection (raw, no wrapper)
        TURN credentials from /api/turn-credentials
        Session key delivery via postMessage to SW
```

---

*This document is the primary security reference for the Nodex beta deployment. For threat model details not covered here, see `.planning/SECURITY-GSD-MIGRATION-2026-05-23.md` and the research paper draft.*
