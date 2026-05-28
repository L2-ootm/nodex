# Nodex Beta API Reference

**Base URL:** `https://nodex-beta-api.vercel.app`

---

## Architecture Overview

The Nodex beta deployment consists of two Vercel projects:

| Project | URL | Role |
|---------|-----|------|
| `nodex-beta` | `https://nodex-beta.vercel.app` | Next.js frontend (beta suite page) |
| `nodex-beta-api` | `https://nodex-beta-api.vercel.app` | Hono serverless API (all data endpoints) |

The frontend proxies select API paths to the backend via Next.js rewrites defined in `apps/beta-suite/next.config.mjs`. This means callers can use either the frontend origin or the API origin for the proxied routes — the behavior is identical. Routes not listed in the rewrite table must be called directly against `nodex-beta-api.vercel.app`.

**Proxied routes (frontend → API):**

```
/api/products/:path*         → https://nodex-beta-api.vercel.app/api/products/:path*
/api/invalidate/:path*       → https://nodex-beta-api.vercel.app/api/invalidate/:path*
/api/session-key             → https://nodex-beta-api.vercel.app/api/session-key
/api/turn-credentials        → https://nodex-beta-api.vercel.app/api/turn-credentials
/api/signal/:path*           → https://nodex-beta-api.vercel.app/api/signal/:path*
```

Note: `/api/beta/*` is **not proxied** — call it directly against `nodex-beta-api.vercel.app`.

---

## Authentication

Two token types exist:

- **Tester token** — format `nodex-tester-<hex>`. Grants access to session-key, turn-credentials, signal/gossip-seed, beta auth, beta sessions, beta evidence, beta presence, beta logs, and beta rooms.
- **Admin token** — format `nodex-admin-<hex>`. Passes all role checks, including admin-only endpoints (ledger, tokens, runs, simulations, audit, control, interceptor).

Tokens are passed as `Authorization: Bearer <token>` on all authenticated requests.

Admin tokens accept both tester-role and admin-role checks. A tester token fails any endpoint that requires admin.

---

## Common Response Headers

All responses include:
- `Content-Type: application/json` (except `/api/products/:id` — see below)
- `Access-Control-Allow-Origin: *`

### Error shapes

**401 Unauthorized**
```json
{ "error": "unauthorized" }
```

**403 Forbidden** (admin required but tester token provided)
```json
{ "error": "admin token required" }
```

**429 Too Many Requests**
```
Retry-After: 60
{ "error": "rate limited" }
```

**400 Bad Request** — body varies by endpoint, e.g.:
```json
{ "error": "roomId and nodeId required" }
```

---

## Rate Limits

Per-IP sliding window enforced by Vercel edge middleware.

| Route group | Limit | Notes |
|-------------|-------|-------|
| `/api/signal/*` | 120 req/min | Sized for 500ms poll cycle with headroom |
| `/api/session-key` | 20 req/min | Fetched once on page load |
| `/api/turn-credentials` | 20 req/min | Fetched once on p2p init |
| `/api/products/*` | Unlimited | Cache read path — must never throttle |
| `/api/beta/*` | Inherited edge defaults | No custom limit set |
| `/api/invalidate/*` | Inherited edge defaults | No custom limit set |

---

## Products API

### GET `/api/products/:id`

Returns an AES-GCM encrypted product payload. No authentication required — this is the hot-path cache read endpoint and must never be rate limited.

**Path parameters:**
- `id` — numeric string (e.g. `1`, `42`)

**Response:** `200 OK`
- `Content-Type: text/plain`
- Body: base64-encoded AES-GCM ciphertext

**Response headers:**

| Header | Example | Description |
|--------|---------|-------------|
| `X-Nodex-Seq` | `3` | Monotonic sequence number for this product path |
| `X-Nodex-Iv` | `aGVsbG8...` | Base64-encoded 96-bit AES-GCM IV |
| `X-Nodex-Key-Id` | `default` | Key identifier for the Service Worker to select the correct decryption key |

**Decryption:** The Service Worker must:
1. Decode the base64 body to get the raw ciphertext bytes.
2. Reconstruct the AAD using `buildPayloadAad(path, seq, keyId)`.
3. Call `subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ciphertext)`.
4. Parse the resulting JSON: `{ id, name, price, seq }`.

**Example (curl):**
```bash
curl -i https://nodex-beta-api.vercel.app/api/products/1
```

```
HTTP/1.1 200 OK
Content-Type: text/plain
X-Nodex-Seq: 1
X-Nodex-Iv: R8kX2mNpLq...
X-Nodex-Key-Id: default

SGVsbG8gV29ybGQ...
```

---

## Invalidate API

### POST `/api/invalidate/products/:id`

Increments the monotonic sequence number for a product path. The next call to `GET /api/products/:id` will return a payload encrypted with the new sequence number.

No authentication required in beta. In production this would require a signed JWT.

**Path parameters:**
- `id` — numeric string matching the product path to invalidate

**Response:** `200 OK`
```json
{
  "path": "/api/products/1",
  "seq": 4,
  "invalidated": true
}
```

After writing the new sequence number, the endpoint attempts a non-blocking call to the signaling server's gossip-seed endpoint to inject a `GOSSIP_INVALIDATE` message into the room. This is fire-and-forget — invalidation is recorded regardless of whether the gossip injection succeeds.

**Example:**
```bash
curl -X POST https://nodex-beta-api.vercel.app/api/invalidate/products/1
```

---

## Session Key API

### GET `/api/session-key`

Returns the AES-GCM session key that the server uses to encrypt product payloads. The beta suite page fetches this once on load and posts it to the Service Worker via `postMessage`.

**Authentication:** `Authorization: Bearer <tester-or-admin-token>` required.

**Response:** `200 OK`
```json
{
  "keyId": "default",
  "keyBytes": "aGVsbG8gd29ybGQgdGhpcyBpcyBhIDMyLWJ5dGU..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `keyId` | string | Matches `X-Nodex-Key-Id` header on product responses |
| `keyBytes` | string | Base64-encoded 32-byte AES-GCM key |

**Session key flow:**

```
1. Page loads → reads nodexBetaToken from URL param
2. p2p-manager.init() calls importSessionKeyFromServer(apiOrigin, token)
3. GET /api/session-key with Authorization: Bearer <token>
4. Response: { keyId: "default", keyBytes: "<base64>" }
5. postMessage({ type: 'IMPORT_SESSION_KEY', keyId, keyBytes: Uint8Array }, [buffer]) to SW
6. SW stores key in memory, ready to decrypt product payloads
```

**401 response:**
```json
{ "error": "unauthorized" }
```

---

## TURN Credentials API

### GET `/api/turn-credentials`

Returns ICE server configuration including STUN and optional TURN entries. Credentials expire after 1 hour. The P2P manager refreshes automatically within 5 minutes of expiry.

**Authentication:** `Authorization: Bearer <tester-or-admin-token>` required.

**Response:** `200 OK`
```json
{
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    { "urls": "turn:openrelay.metered.ca:80", "username": "openrelayproject", "credential": "openrelayproject" },
    { "urls": "turn:openrelay.metered.ca:443", "username": "openrelayproject", "credential": "openrelayproject" },
    { "urls": "turns:openrelay.metered.ca:443", "username": "openrelayproject", "credential": "openrelayproject" }
  ],
  "expiresAt": 1780000618084
}
```

| Field | Type | Description |
|-------|------|-------------|
| `iceServers` | array | ICE server config objects; always includes STUN, TURN only if env vars set |
| `expiresAt` | number | Unix milliseconds; TTL is 1 hour from request time |

If `NODEX_TURN_URLS`, `NODEX_TURN_USERNAME`, or `NODEX_TURN_CREDENTIAL` are not configured, the response contains only the Google STUN entry.

**Usage in p2p-manager:**

```
fetchTurnCredentials(apiOrigin, token)
→ returned iceServers replaces default STUN-only config in runtimeConfig
→ connectToPeer() checks: if Date.now() > turnCredentialExpiresAt - 300_000 → trigger background refresh
```

On 401 or fetch failure, the manager silently falls back to STUN-only.

---

## Signaling API

All signaling routes are served by `api/signal/[...path].ts` as a single Hono app.

**State persistence priority** (first available wins):
1. Supabase `beta_logs` table — when `SUPABASE_URL` + `SUPABASE_SECRET_KEY` are set, or `NODEX_BETA_STORAGE_DRIVER=supabase`
2. Vercel Blob — when `BLOB_READ_WRITE_TOKEN` is set
3. In-memory Map — fallback for local dev or cold starts

Node TTL: 45 seconds. Message TTL: 60 seconds. Maximum stored messages per room: 500.

---

### POST `/api/signal/join`

Register a node in a room and retrieve existing peers.

**Authentication:** None required.

**Request body:**
```json
{
  "roomId": "beta-abc123",
  "nodeId": "node-uuid-here"
}
```

**Response:** `200 OK`
```json
{
  "peers": ["node-uuid-peer1", "node-uuid-peer2"],
  "polite": true,
  "after": 14
}
```

| Field | Type | Description |
|-------|------|-------------|
| `peers` | string[] | Up to 5 recently-active node IDs (excluding self) to initiate offers toward |
| `polite` | boolean | `true` if peers were already present — caller takes the polite role in perfect negotiation |
| `after` | number | Message cursor; pass as `after` param in subsequent `/api/signal/poll` calls |

---

### POST `/api/signal/send`

Publish a signaling message (SDP offer/answer or ICE candidate) into a room.

**Authentication:** None required.

**Request body:**
```json
{
  "roomId": "beta-abc123",
  "message": {
    "type": "SDP_OFFER",
    "from": "node-uuid-a",
    "to": "node-uuid-b",
    "sdp": "v=0\r\no=..."
  }
}
```

Supported `message.type` values: `SDP_OFFER`, `SDP_ANSWER`, `ICE_CANDIDATE`.

All message types require `from` and `to` fields. `ICE_CANDIDATE` messages additionally carry a `candidate` field.

**Response:** `200 OK`
```json
{ "ok": true }
```

---

### GET `/api/signal/poll`

Retrieve messages since a given cursor, filtered to messages targeting this node or broadcast to the room.

**Authentication:** None required.

**Rate limit:** 120 req/min per IP.

**Query parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `roomId` | Yes | Room to poll |
| `nodeId` | Yes | Caller's node ID; messages from self are excluded |
| `after` | Yes | Return messages with id > this cursor (use value from `/join` response) |

**Response:** `200 OK`
```json
{
  "messages": [
    {
      "id": 15,
      "createdAt": 1748476800000,
      "message": {
        "type": "SDP_OFFER",
        "from": "node-uuid-a",
        "to": "node-uuid-b",
        "sdp": "v=0\r\n..."
      }
    }
  ]
}
```

Each envelope has `id` (use as next `after` cursor), `createdAt` (Unix ms), and `message`.

Polling nodes also update their `lastSeen` timestamp, which keeps them visible in subsequent `/join` peer lists.

---

### POST `/api/signal/leave`

Remove a node from the room. Best-effort — peers will also expire naturally after 45 seconds without a poll heartbeat.

**Authentication:** None required.

**Request body:**
```json
{
  "roomId": "beta-abc123",
  "nodeId": "node-uuid-here"
}
```

**Response:** `200 OK`
```json
{ "ok": true }
```

---

### POST `/api/signal/gossip-seed`

Inject a `GOSSIP_INVALIDATE` message into a room. All polling nodes will receive it on their next poll and forward it via the epidemic gossip engine.

**Authentication:** `Authorization: Bearer <tester-or-admin-token>` required.

**Request body:**
```json
{
  "roomId": "beta-abc123",
  "key": "/api/products/1",
  "seq": 4,
  "originNodeId": "server"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `roomId` | Yes | Room to seed |
| `key` | Yes | Cache key path being invalidated |
| `seq` | Yes | New sequence number |
| `originNodeId` | No | Defaults to `"server"` |

**Response:** `200 OK`
```json
{ "seeded": true }
```

**401 response:**
```json
{ "error": "unauthorized" }
```

---

## Beta API

All beta routes are served by `api/beta/[...path].ts`. These endpoints are **not proxied** through the frontend — call them directly against `https://nodex-beta-api.vercel.app`.

CORS is restricted to configured allowed origins (`NODEX_BETA_ALLOWED_ORIGINS` or `NODEX_BETA_APP_ORIGIN`). Requests from unlisted origins receive `403 { "error": "origin not allowed" }`.

---

### GET `/api/beta/health`

Returns the server's configuration status. No authentication required.

**Response:** `200 OK`
```json
{
  "ok": true,
  "invite_tokens_configured": 3,
  "admin_tokens_configured": 1,
  "allowed_origins_configured": 2
}
```

---

### POST `/api/beta/auth`

Validates a bearer token and returns its role. Use this to check whether a token is valid before starting a session.

**Authentication:** `Authorization: Bearer <token>` required (checked in body).

**Response:** `200 OK`
```json
{
  "role": "tester",
  "tokenPreview": "nodex-test...a1b2",
  "invite": {
    "label": "Alice",
    "assignedName": "Alice",
    "assignedEmail": "alice@example.com",
    "welcomeNote": "Thanks for testing!",
    "maxSessions": 1
  }
}
```

`invite` is `null` for tokens not configured with metadata. For admin tokens, `invite` is also `null`.

**401 response:**
```json
{ "error": "invalid beta token" }
```

---

### POST `/api/beta/sessions`

Create a participant record and issue a session token. Each tester invite token may only be used `maxSessions` times (default: 1).

**Authentication:** `Authorization: Bearer <tester-or-admin-token>` required.

**Request body:**
```json
{
  "name": "Alice",
  "email": "alice@example.com",
  "city": "São Paulo",
  "country": "Brazil",
  "networkLabel": "home broadband",
  "consentToCredit": true,
  "contributionNote": "Testing from a residential connection"
}
```

| Field | Required | Max length | Description |
|-------|----------|------------|-------------|
| `name` | Yes | 120 | Display name for contributor ledger |
| `email` | No | 200 | Email (must contain `@`) |
| `city` | No | 80 | City for geographic evidence |
| `country` | No | 80 | Country |
| `networkLabel` | No | 120 | Self-reported network type |
| `consentToCredit` | Yes | — | Must be `true` to appear in ledger |
| `contributionNote` | No | 1000 | Free-text note |

**Response:** `201 Created`
```json
{
  "participantId": "beta-a1b2c3d4e5f6g7h8",
  "sessionToken": "beta-session-a1b2c3d4e5f6g7h8",
  "roomId": "beta-beta-a1b2c3d4e5f6g7h8",
  "testUrl": "https://nodex-beta.vercel.app/?nodexRoom=beta-beta-a1b2c3d4e5f6g7h8&nodexTopology=beta-external&nodexSignalingUrl=...",
  "ledgerNotice": "Saved as contributor/test-participant evidence, not a legal inventorship determination."
}
```

The `sessionToken` is used as the bearer token for `/api/beta/evidence`. It is valid for 14 days.

**409 response** (token already used to its session limit):
```json
{ "error": "this tester token has already been used" }
```

---

### POST `/api/beta/evidence`

Submit test evidence (peer-fetch counts, latency metrics, ICE candidate types, etc.) for a session.

**Authentication:** `Authorization: Bearer <session-token>` — use the `sessionToken` from `/api/beta/sessions`, not the invite token.

**Request body:**
```json
{
  "participantId": "beta-a1b2c3d4e5f6g7h8",
  "roomId": "beta-beta-a1b2c3d4e5f6g7h8",
  "topologyLabel": "two-machine-same-lan",
  "result": "pass",
  "notes": "P2P fetch succeeded on all 10 requests",
  "telemetry": [
    { "event": "peer-fetch", "latencyMs": 18, "seq": 3 }
  ],
  "storagePressure": { "cacheBytes": 204800 },
  "runtimeConfig": { "nodeCount": 2, "turnUsed": false }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `participantId` | Yes | Must match the session |
| `roomId` | Yes | Must match the session |
| `topologyLabel` | Yes | Max 120 chars; e.g. `"two-machine-same-lan"` |
| `result` | Yes | One of: `pass`, `partial`, `fail`, `not_measured` |
| `notes` | No | Max 2000 chars |
| `telemetry` | No | Array of up to 100 event objects |
| `storagePressure` | No | Arbitrary object |
| `runtimeConfig` | No | Arbitrary object |

**Response:** `201 Created`
```json
{
  "evidenceId": "evidence-a1b2c3d4e5f6g7h8",
  "createdAt": "2026-05-28T00:00:00.000Z"
}
```

---

### POST `/api/beta/presence`

Send a presence heartbeat. Returns the list of currently online participants in the room (last seen within 3 minutes). Call every 5 seconds to maintain presence.

**Authentication:** `Authorization: Bearer <tester-or-admin-token>` required.

**Request body:**
```json
{
  "name": "Alice",
  "mode": "solo",
  "roomId": "beta-beta-a1b2c3d4e5f6g7h8",
  "participantId": "beta-a1b2c3d4e5f6g7h8"
}
```

All fields are optional. `name` defaults to the token's `assignedName` or the role string.

**Response:** `200 OK`
```json
{
  "online": [
    {
      "name": "Alice",
      "role": "tester",
      "mode": "solo",
      "lastSeen": "2026-05-28T00:00:00.000Z",
      "participantId": "beta-a1b2c3d4e5f6g7h8",
      "roomId": "beta-beta-a1b2c3d4e5f6g7h8"
    }
  ]
}
```

---

### GET `/api/beta/presence`

Read current presence without sending a heartbeat.

**Authentication:** `Authorization: Bearer <tester-or-admin-token>` required.

**Query parameters:**
- `roomId` (optional) — filter presence to a specific room

**Response:** `200 OK` — same shape as `POST /api/beta/presence`.

---

### GET `/api/beta/rooms`

List rooms available for testers to join. Returns runs in `ready` or `running` status.

**Authentication:** `Authorization: Bearer <tester-or-admin-token>` required.

**Response:** `200 OK`
```json
{
  "rooms": [
    {
      "runId": "run-a1b2c3d4e5f6g7h8",
      "roomId": "beta-run-a1b2c3d4e5f6g7h8",
      "title": "LAN validation — 2 nodes",
      "scenario": "p2p-cache-hit",
      "dataType": "products",
      "nodeCount": 2,
      "status": "ready",
      "createdAt": "2026-05-28T00:00:00.000Z"
    }
  ]
}
```

---

### POST `/api/beta/logs`

Submit a client-side log entry from a tester or admin.

**Authentication:** `Authorization: Bearer <tester-or-admin-token>` required.

**Request body:**
```json
{
  "level": "info",
  "message": "P2P connection established",
  "participantId": "beta-a1b2c3d4e5f6g7h8",
  "roomId": "beta-beta-a1b2c3d4e5f6g7h8",
  "runId": "run-a1b2c3d4e5f6g7h8",
  "details": { "peerCount": 1, "iceType": "host" }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `level` | Yes | `info`, `warn`, or `error` |
| `message` | Yes | Max 500 chars |
| `participantId` | No | |
| `roomId` | No | |
| `runId` | No | |
| `details` | No | Arbitrary object |

**Response:** `201 Created`
```json
{
  "logId": "log-a1b2c3d4e5f6g7h8",
  "createdAt": "2026-05-28T00:00:00.000Z"
}
```

---

## Admin-Only Endpoints

The following endpoints require an admin token.

---

### GET `/api/beta/ledger`

Returns the full contributor ledger — participants and evidence records. Used for research attribution.

**Authentication:** Admin token required.

**Response:** `200 OK`
```json
{
  "schema_version": 1,
  "generatedAt": "2026-05-28T00:00:00.000Z",
  "notice": "Contributor ledger for research attribution and attorney review; not a legal inventorship determination.",
  "participants": [
    {
      "participantId": "beta-a1b2c3d4e5f6g7h8",
      "roomId": "beta-beta-a1b2c3d4e5f6g7h8",
      "name": "Alice",
      "city": "São Paulo",
      "country": "Brazil",
      "consentToCredit": true,
      "evidenceCount": 3,
      "latestEvidenceAt": "2026-05-28T00:00:00.000Z",
      "createdAt": "2026-05-28T00:00:00.000Z"
    }
  ],
  "evidence": [...]
}
```

---

### GET `/api/beta/tokens`

List all tokens: environment-configured counts and dynamically created token records.

**Authentication:** Admin token required.

**Response:** `200 OK`
```json
{
  "environment": [
    { "role": "admin", "count": 1 },
    { "role": "tester", "count": 3 }
  ],
  "createdTokens": [
    {
      "tokenId": "token-a1b2c3d4e5f6g7h8",
      "tokenPreview": "nodex-test...a1b2",
      "role": "tester",
      "label": "Alice",
      "assignedName": "Alice",
      "assignedEmail": "alice@example.com",
      "maxSessions": 1,
      "active": true,
      "useCount": 1,
      "lastUsedAt": "2026-05-28T00:00:00.000Z",
      "createdAt": "2026-05-28T00:00:00.000Z",
      "createdBy": "admin...",
      "revokedAt": null,
      "revokedBy": null,
      "expiresAt": null
    }
  ]
}
```

---

### POST `/api/beta/tokens`

Dynamically create a new tester or admin token. Returns the full token value (shown once — not stored in plaintext).

**Authentication:** Admin token required.

**Request body:**
```json
{
  "role": "tester",
  "label": "Bob",
  "assignedName": "Bob",
  "assignedEmail": "bob@example.com",
  "welcomeNote": "Welcome to the Nodex beta!",
  "maxSessions": 1
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `role` | No | `tester` (default) or `admin` |
| `label` | No | Defaults to `assignedName` or `"Beta tester"` |
| `assignedName` | No | |
| `assignedEmail` | No | |
| `welcomeNote` | No | Max 500 chars |
| `maxSessions` | No | 1–20; default 1 for tester, 20 for admin |

**Response:** `201 Created`
```json
{
  "token": "nodex-tester-a1b2c3d4e5f6...",
  "tokenId": "token-a1b2c3d4e5f6g7h8",
  "tokenPreview": "nodex-test...c7d8",
  "role": "tester",
  "label": "Bob",
  "active": true,
  "maxSessions": 1,
  "createdAt": "2026-05-28T00:00:00.000Z"
}
```

The `token` field appears only in this response. Copy it immediately.

---

### POST `/api/beta/tokens/:tokenId/revoke`

Revoke a token. The token immediately stops passing auth checks.

**Authentication:** Admin token required.

**Response:** `200 OK`
```json
{
  "token": { "tokenId": "token-a1b2c3d4e5f6g7h8", "active": false, "revokedAt": "2026-05-28T00:00:00.000Z", ... }
}
```

**404 response:**
```json
{ "error": "token not found" }
```

---

### POST `/api/beta/runs`

Create a test run and generate a simulation dataset.

**Authentication:** Admin token required.

**Request body:**
```json
{
  "title": "LAN validation — 2 nodes",
  "scenario": "p2p-cache-hit",
  "dataType": "products",
  "nodeCount": 2,
  "notes": "Initial external LAN test"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `scenario` | Yes | e.g. `p2p-cache-hit`, `server-fallback` |
| `dataType` | Yes | e.g. `products` |
| `nodeCount` | Yes | 2–50 |
| `title` | No | Max 120 chars |
| `notes` | No | Max 1000 chars |

**Response:** `201 Created` — includes the run record, a simulation record, and a `testUrl` for testers to open.

---

### GET `/api/beta/runs`

List all test runs.

**Authentication:** Admin token required.

**Response:** `200 OK`
```json
{
  "runs": [...]
}
```

---

### POST `/api/beta/simulations`

Create a simulation independent of the `/api/beta/runs` flow, with a custom `requestCount`.

**Authentication:** Admin token required.

**Request body:** same as `POST /api/beta/runs`, plus optional `requestCount` (10–200, default 40).

**Response:** `201 Created`
```json
{
  "run": {...},
  "simulation": {
    "simulationId": "sim-a1b2c3d4e5f6g7h8",
    "metrics": {
      "totalRequests": 40,
      "swCache": 28,
      "peerFetch": 9,
      "serverFallback": 3,
      "hitRatePct": 92.5,
      "p50LatencyMs": 4,
      "p95LatencyMs": 19,
      "invalidationReachPct": 100,
      "estimatedOriginReadsAvoided": 37
    },
    "events": [...]
  },
  "testUrl": "https://nodex-beta.vercel.app/?nodexRoom=...&nodexTopology=beta-external&..."
}
```

---

### GET `/api/beta/simulations`

List all simulation records.

**Authentication:** Admin token required.

---

### GET `/api/beta/control`

Dashboard summary: participant count, evidence count, run count, simulation count, log count, latest run and simulation, and the 8 most recent log entries.

**Authentication:** Admin token required.

**Response:** `200 OK`
```json
{
  "generatedAt": "2026-05-28T00:00:00.000Z",
  "totals": {
    "participants": 5,
    "evidence": 12,
    "runs": 3,
    "simulations": 3,
    "logs": 47
  },
  "latestRun": {...},
  "latestSimulation": {...},
  "latestLogs": [...]
}
```

---

### GET `/api/beta/logs`

Read all server-side and client-submitted log entries.

**Authentication:** Admin token required.

**Response:** `200 OK`
```json
{
  "logs": [...]
}
```

---

### GET `/api/beta/audit`

Read the last 100 audit events (auth attempts, token creation/revocation, session creation).

**Authentication:** Admin token required.

**Response:** `200 OK`
```json
{
  "events": [
    {
      "eventId": "audit-a1b2c3d4e5f6g7h8",
      "eventType": "beta_session_created",
      "severity": "info",
      "actorRole": "tester",
      "targetType": "participant",
      "targetId": "beta-a1b2c3d4e5f6g7h8",
      "createdAt": "2026-05-28T00:00:00.000Z"
    }
  ]
}
```

---

### GET `/api/beta/interceptor`

Returns the last 50 encrypted payload capture records logged by `GET /api/products/:id`. Each record includes the path, sequence number, IV (base64), ciphertext sample (first 64 bytes, base64), and a note confirming AES-GCM-256 authentication.

**Authentication:** Admin token required.

**Response:** `200 OK`
```json
{
  "captures": [
    {
      "path": "/api/products/1",
      "seq": 3,
      "iv_b64": "R8kX2m...",
      "ciphertext_sample_b64": "SGVsbG8...",
      "timestamp": "2026-05-28T00:00:00.000Z",
      "note": "AES-GCM-256 — auth tag rejects any tamper or key mismatch"
    }
  ]
}
```

Only populated when `BLOB_READ_WRITE_TOKEN` is configured.

---

## Environment Variables

### `nodex-beta-api` (Vercel project)

```
# Required — 32-byte AES-GCM key as 64 lowercase hex chars
NODEX_SESSION_KEY_HEX=<64 hex chars>

# Tester tokens — pipe-delimited: token|Name|Email|WelcomeNote
# Multiple tokens separated by comma (must start with nodex-)
NODEX_BETA_TOKENS=nodex-tester-<hex>|Alice|alice@example.com|Welcome!,nodex-tester-<hex>|Bob||

# Admin tokens — comma-separated
NODEX_BETA_ADMIN_TOKENS=nodex-admin-<hex>

# TURN server config (all three required to enable TURN entries)
NODEX_TURN_URLS=turn:openrelay.metered.ca:80,turn:openrelay.metered.ca:443,turns:openrelay.metered.ca:443
NODEX_TURN_USERNAME=openrelayproject
NODEX_TURN_CREDENTIAL=openrelayproject

# Supabase (recommended over Vercel Blob for signaling and beta state)
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SECRET_KEY=<service role key>

# Force Supabase storage driver (auto-detected if SUPABASE_URL present and no BLOB_READ_WRITE_TOKEN)
NODEX_BETA_STORAGE_DRIVER=supabase

# Vercel Blob (alternative to Supabase; lower priority when both are set)
BLOB_READ_WRITE_TOKEN=<vercel blob token>

# CORS — origins allowed to call /api/beta/* (comma-separated, no trailing slash)
NODEX_BETA_ALLOWED_ORIGINS=https://nodex-beta.vercel.app,http://localhost:4173
NODEX_BETA_APP_ORIGIN=https://nodex-beta.vercel.app

# Optional — HTTP URL to signaling server for automatic gossip-seed on invalidate
NODEX_BETA_SIGNALING_HTTP_URL=https://nodex-beta-api.vercel.app/api/signal
```

### `nodex-beta` (Vercel project — Next.js frontend)

```
# Points the Next.js rewrites at the API project
NEXT_PUBLIC_NODEX_BETA_API_URL=https://nodex-beta-api.vercel.app
```

---

## Adding Tester Tokens

There are two methods.

### Method 1: Environment variable (static, no API call)

Add a comma-separated entry to `NODEX_BETA_TOKENS` on `nodex-beta-api`:

```
NODEX_BETA_TOKENS=nodex-tester-<32hexchars>|Alice|alice@example.com|Welcome to the beta!,nodex-tester-<32hexchars>|Bob
```

Format per token entry: `<token>|<Name>|<Email>|<WelcomeNote>`

- Only `<token>` is required; the pipe separators and metadata fields are optional.
- Token must start with `nodex-` and be at least 20 characters long.
- Redeploy or restart the function after changing the env var for it to take effect.

To generate a token value: `node -e "console.log('nodex-tester-' + require('crypto').randomUUID().replaceAll('-',''))"`.

### Method 2: Admin API (dynamic, no redeploy)

```bash
curl -X POST https://nodex-beta-api.vercel.app/api/beta/tokens \
  -H "Authorization: Bearer nodex-admin-<your-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "role": "tester",
    "assignedName": "Charlie",
    "assignedEmail": "charlie@example.com",
    "welcomeNote": "Thanks for testing Nodex!",
    "maxSessions": 1
  }'
```

The response includes a `token` field containing the full token value. Store it immediately — it is not retrievable later.

To revoke: `POST /api/beta/tokens/:tokenId/revoke` with the `tokenId` from the token record.

Dynamically created tokens survive across deployments (stored in Supabase or Vercel Blob). Environment-configured tokens are re-parsed on each cold start and do not appear in `createdTokens` — only in the `environment` counts returned by `GET /api/beta/tokens`.
