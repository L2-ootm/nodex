# Nodex Beta — Deployment and Operations Guide

This guide covers everything needed to deploy, configure, and operate the Nodex beta. It assumes the reader is a developer who has not previously worked with this codebase.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Repository Layout](#repository-layout)
3. [Prerequisites](#prerequisites)
4. [Initial Setup](#initial-setup)
5. [Environment Variables Reference](#environment-variables-reference)
6. [Build and Deploy Flow](#build-and-deploy-flow)
7. [Creating Tester Invite Tokens](#creating-tester-invite-tokens)
8. [End-to-End Session Flow](#end-to-end-session-flow)
9. [P2P Connection Topology](#p2p-connection-topology)
10. [Signaling State Persistence](#signaling-state-persistence)
11. [Verifying a Deployment](#verifying-a-deployment)
12. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

Nodex beta is split across two Vercel projects. They are independent deployments but work together: the frontend proxies all API calls to the API project via Next.js rewrites.

| Project | Production URL | Repo path | Responsibility |
|---------|---------------|-----------|----------------|
| `nodex-beta-api` | `https://nodex-beta-api.vercel.app` | `api/` | Session keys, TURN credentials, signaling, product endpoints, beta management |
| `nodex-beta` | `https://nodex-beta.vercel.app` | `apps/beta-suite/` | Beta dashboard UI (Next.js 15); proxies all `/api/*` calls to `nodex-beta-api` |

The frontend never calls `nodex-beta-api.vercel.app` directly from user browsers in production. All `/api/*` traffic routes through the Next.js rewrite in `apps/beta-suite/next.config.mjs`, which forwards requests to the API project. This keeps CORS simple and lets the frontend add edge-level middleware (rate limiting, token validation) before requests reach the API.

The **P2P runtime** lives in `apps/beta-suite/public/metrics.html`. This is an iframe loaded inside the tester dashboard. It bootstraps the Service Worker, initializes `p2p-manager`, fetches session keys and TURN credentials, and reports metrics back to the parent page via `postMessage`.

---

## Repository Layout

```
L2-NODEX/
├── api/                        # Hono + Vercel serverless functions (nodex-beta-api)
│   └── ...
├── apps/
│   └── beta-suite/             # Next.js 15 frontend (nodex-beta)
│       ├── public/
│       │   ├── metrics.html    # P2P runtime iframe — loads p2p-manager + SW
│       │   └── assets/         # Built JS assets copied from dist/assets/
│       └── next.config.mjs     # Rewrites /api/* → nodex-beta-api.vercel.app
├── src/                        # Core source: SW, p2p-manager, config, crypto
│   ├── sw/sw.ts                # Service Worker — fetch routing, freshness, decrypt
│   ├── p2p/p2p-manager.ts      # Page-side WebRTC connection manager
│   ├── shared/config.ts        # Shared configuration
│   └── ...
├── scripts/
│   └── sync-beta-runtime.ts    # Copies built assets into apps/beta-suite/public/assets/
├── dist/                       # Build output from `npm run build`
│   └── assets/                 # Compiled JS/CSS assets
└── package.json
```

---

## Prerequisites

- Node.js 20 LTS
- Vercel CLI: `npm install -g vercel`
- Access to the Vercel team with `nodex-beta` and `nodex-beta-api` projects
- A Supabase project (free tier is sufficient for beta scale)
- TURN credentials — Open Relay Project is used for PoC (`openrelay.metered.ca`); replace with a private TURN server before scaling

Verify your Vercel CLI is authenticated:

```bash
vercel whoami
```

---

## Initial Setup

These steps are only required the first time. For subsequent deploys, go directly to [Build and Deploy Flow](#build-and-deploy-flow).

### 1. Install dependencies

```bash
npm install
```

### 2. Generate the session encryption key

The session key is a 32-byte AES-GCM-256 key stored as 64 lowercase hex characters. This key encrypts all product payloads served to beta clients. Generate it once and store it in Vercel.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Example output: `a3f8c2e1d94b7056e28a31f6c04b9e7d2a5f8c3b1e6d9024f7a3c8e51b2d6f04`

Keep this value. You will set it as `NODEX_SESSION_KEY_HEX` on both Vercel projects (the API uses it to encrypt; the value must be consistent across redeploys).

### 3. Generate your first admin token

```bash
node -e "console.log('nodex-admin-' + require('crypto').randomBytes(16).toString('hex'))"
```

Example output: `nodex-admin-4e92b1a37f06c845d3e198f20d7b5a62`

Store this somewhere safe. You will set it as `NODEX_BETA_ADMIN_TOKENS` on `nodex-beta-api`.

### 4. Set environment variables on Vercel

Set all required env vars on each project via the Vercel dashboard (Settings → Environment Variables → Production) or via the CLI:

```bash
# Link to API project and set vars
vercel link --yes --project nodex-beta-api
vercel env add NODEX_SESSION_KEY_HEX production
vercel env add NODEX_BETA_TOKENS production
vercel env add NODEX_BETA_ADMIN_TOKENS production
vercel env add NODEX_TURN_URLS production
vercel env add NODEX_TURN_USERNAME production
vercel env add NODEX_TURN_CREDENTIAL production
vercel env add SUPABASE_URL production
vercel env add SUPABASE_SECRET_KEY production
vercel env add NODEX_BETA_STORAGE_DRIVER production

# Link to frontend project and set vars
vercel link --yes --project nodex-beta
vercel env add NEXT_PUBLIC_NODEX_BETA_API_URL production
```

See the [Environment Variables Reference](#environment-variables-reference) for exact values.

---

## Environment Variables Reference

### nodex-beta-api (set in Vercel Production environment)

| Variable | Required | Description |
|----------|----------|-------------|
| `NODEX_SESSION_KEY_HEX` | Yes | AES-GCM-256 session encryption key — 32 bytes as 64 lowercase hex chars |
| `NODEX_BETA_TOKENS` | Yes | Comma-separated tester invite tokens (see format below) |
| `NODEX_BETA_ADMIN_TOKENS` | Yes | Comma-separated admin tokens; admin token passes all auth checks |
| `NODEX_TURN_URLS` | Yes | Comma-separated TURN/TURNS server URLs |
| `NODEX_TURN_USERNAME` | Yes | TURN server username |
| `NODEX_TURN_CREDENTIAL` | Yes | TURN server credential/password |
| `SUPABASE_URL` | Yes | Supabase project URL: `https://<project-id>.supabase.co` |
| `SUPABASE_SECRET_KEY` | Yes | Supabase service role key (from Supabase → Settings → API) |
| `NODEX_BETA_STORAGE_DRIVER` | No | Set to `supabase` to force Supabase persistence; auto-detects if omitted |

**NODEX_SESSION_KEY_HEX**

```
Generate:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

Example value:
a3f8c2e1d94b7056e28a31f6c04b9e7d2a5f8c3b1e6d9024f7a3c8e51b2d6f04
```

Must be exactly 64 hex characters. This value must stay consistent — changing it invalidates all active sessions.

**NODEX_BETA_TOKENS**

```
Format per entry: nodex-tester-<32hex>|<Name>||<WelcomeNote>
Multiple entries: comma-separated

Example (single tester):
nodex-tester-b27babb8559e48138830a7f743320b41|Natanny||Oi Natanny! Obrigado por ajudar a testar o Nodex.

Example (two testers):
nodex-tester-b27babb8559e48138830a7f743320b41|Natanny||Oi Natanny! Obrigado por ajudar a testar o Nodex.,nodex-tester-b93af8a11d79497cabe4517a255e1e7c|Francisco||Hey Francisco! Thanks for being part of the first Nodex beta.
```

Note the double pipe (`||`) before the welcome note — field 3 (between the pipes) is reserved and must be empty.

**NODEX_BETA_ADMIN_TOKENS**

```
Format: nodex-admin-<32hex>
Multiple: comma-separated

Example:
nodex-admin-4e92b1a37f06c845d3e198f20d7b5a62
```

**NODEX_TURN_URLS**

```
Use Open Relay Project for PoC:
turn:openrelay.metered.ca:80,turn:openrelay.metered.ca:443,turns:openrelay.metered.ca:443
```

For production, replace with a private Coturn instance or a managed TURN provider (Metered, Twilio, etc.).

**NODEX_TURN_USERNAME / NODEX_TURN_CREDENTIAL**

```
Open Relay Project credentials:
NODEX_TURN_USERNAME=openrelayproject
NODEX_TURN_CREDENTIAL=openrelayproject
```

**SUPABASE_URL / SUPABASE_SECRET_KEY**

```
SUPABASE_URL=https://<project-id>.supabase.co
SUPABASE_SECRET_KEY=<service-role-key>
```

Retrieve from Supabase dashboard → Settings → API → service_role key. Never use the anon key here.

**NODEX_BETA_STORAGE_DRIVER**

```
NODEX_BETA_STORAGE_DRIVER=supabase
```

Omit this to let the API auto-detect based on whether `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are present.

---

### nodex-beta (set in Vercel Production environment)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_NODEX_BETA_API_URL` | Yes | API project base URL used by rewrites and client-side code |

```
NEXT_PUBLIC_NODEX_BETA_API_URL=https://nodex-beta-api.vercel.app
```

---

## Build and Deploy Flow

Follow these steps for every release that includes source changes.

### Step 1: Build core source

Run this whenever `src/` files change (Service Worker, p2p-manager, config, crypto):

```bash
npm run build
```

This compiles TypeScript and emits built assets into `dist/assets/`.

### Step 2: Sync runtime assets into the frontend

```bash
npx tsx scripts/sync-beta-runtime.ts
```

This copies the built JS assets from `dist/assets/` into `apps/beta-suite/public/assets/` and updates the asset hash reference in `apps/beta-suite/public/metrics.html`. Always run this after `npm run build` before deploying the frontend.

### Step 3: Deploy the API

```bash
vercel link --yes --project nodex-beta-api && vercel --prod
```

### Step 4: Deploy the frontend

```bash
vercel link --yes --project nodex-beta && vercel --prod
```

### Step 5: Restore the working link (optional)

If you switch between projects frequently, re-link to `nodex-beta` for local dev:

```bash
vercel link --yes --project nodex-beta
```

### Deploy checklist

| Change type | Build required | Sync required | Deploy API | Deploy frontend |
|-------------|---------------|---------------|------------|-----------------|
| `src/` (SW, p2p, config) | Yes | Yes | No | Yes |
| `api/` (routes, auth) | No | No | Yes | No |
| `apps/beta-suite/` (UI) | No | No | No | Yes |
| Env var change | No | No | Yes (for API vars) | Yes (for frontend vars) |

> Vercel does not hot-reload environment variables. Any change to env vars requires a redeploy of the affected project.

---

## Creating Tester Invite Tokens

### Generate a token

```bash
node -e "console.log('nodex-tester-' + require('crypto').randomBytes(16).toString('hex'))"
```

Example output: `nodex-tester-b27babb8559e48138830a7f743320b41`

### Add the token to the env var

1. Open `NODEX_BETA_TOKENS` in the Vercel dashboard for `nodex-beta-api` (Settings → Environment Variables → Production).

2. Append the new entry to the existing value. Format: `nodex-tester-<hash>|<Name>||<WelcomeNote>`

   Adding a third tester to an existing value:
   ```
   nodex-tester-b27babb8559e48138830a7f743320b41|Natanny||Oi Natanny! Obrigado por ajudar a testar o Nodex.,nodex-tester-b93af8a11d79497cabe4517a255e1e7c|Francisco||Hey Francisco! Thanks for being part of the first Nodex beta.,nodex-tester-c74de5f22a8b3910f1a2796bc48d9e85|Ana||Olá Ana! Bem-vinda ao beta do Nodex.
   ```

3. Save and redeploy the API:
   ```bash
   vercel link --yes --project nodex-beta-api && vercel --prod
   ```

### Share the invite URL

Send the tester either:
- The full URL with the token embedded: `https://nodex-beta.vercel.app/?token=nodex-tester-b27babb8559e48138830a7f743320b41`
- Or the base URL `https://nodex-beta.vercel.app` and the token separately to enter manually

### Verify the token works

```bash
curl -s -H "Authorization: Bearer nodex-tester-b27babb8559e48138830a7f743320b41" \
  https://nodex-beta-api.vercel.app/api/session-key
```

Expected response: `{"keyId":"default","keyBytes":"<base64>"}`

If you see `{"error":"unauthorized"}`, see the troubleshooting section.

---

## End-to-End Session Flow

This describes what happens from the moment a tester opens the beta URL to when evidence is recorded.

```
 1. Tester opens https://nodex-beta.vercel.app
 2. Enters invite token → POST /api/beta/login
      → API validates token against NODEX_BETA_TOKENS
      → Returns: role, name, welcome_note
 3. Tester creates or joins a room (solo mode or admin-shared room)
 4. Tester clicks "Run Protocol Check"
 5. TesterPages.tsx calls buildRuntimeUrl(roomId, mode, signalBase, auth.token)
      → Constructs metrics.html URL with nodexBetaToken=<token> as a query param
      → Loads metrics.html in an iframe
 6. metrics.html bootstraps:
      a. Registers the Service Worker (scoped to /)
      b. Loads p2p-manager.js from /assets/
 7. p2p-manager.init():
      a. Reads nodexBetaToken from window.location.search
      b. GET /api/turn-credentials  (Bearer <token>)
           → Returns: { iceServers: [STUN + TURN entries], expiresAt: <timestamp> }
           → Credentials are cached with a 1-hour TTL; refresh is triggered 5 min before expiry
      c. GET /api/session-key  (Bearer <token>)
           → Returns: { keyId: "default", keyBytes: "<base64>" }
      d. postMessage IMPORT_SESSION_KEY to the registered Service Worker
           → SW stores the AES-GCM key; can now decrypt product payloads
 8. p2p-manager joins the signaling room:
      → POST /api/signal/join with roomId + peerId
      → Receives peer list from signaling state in Supabase
      → For each peer: initiates WebRTC offer/answer exchange via /api/signal/*
      → Establishes RTCDataChannel connections
 9. Tester triggers product fetches (manual or automated in the test sequence)
10. Service Worker intercepts each /api/products/* request:
      → Checks Cache API for a fresh entry (validates sequence number)
      → If cache miss: tries a P2P fetch from connected peers
      → If P2P miss or no peers: fetches from the server, decrypts, caches
      → Records metrics: cache_hit, peer_fetch, latency, selected_candidate_type
11. Metrics stream over BroadcastChannel → TesterPages.tsx displays progress and logs
12. On test completion: POST /api/beta/evidence
      → Evidence stored in Supabase beta_logs table
      → Session marked complete
```

---

## P2P Connection Topology

Each browser context running `metrics.html` is one node in the Nodex network.

| Layer | Technology | Notes |
|-------|------------|-------|
| Cache and fetch interception | Service Worker (Cache API) | Registered at `metrics.html` origin, scoped to `/` |
| P2P management | `p2p-manager.ts` on the page thread | WebRTC is unavailable in SW scope; must run on the page |
| SW ↔ page communication | `postMessage` / `MessagePort` | Used for IMPORT_SESSION_KEY and metric relay |
| Peer discovery | Hono signaling server (`api/`) | Room-based; state persisted in Supabase |
| Data transport | `RTCDataChannel` (raw `RTCPeerConnection`) | No wrapper library; binary framing is custom |
| NAT traversal | Google STUN + Open Relay TURN | STUN for direct connections; TURN relay for symmetric NAT |
| Content encryption | AES-GCM-256 (WebCrypto `SubtleCrypto`) | Server encrypts payloads; SW decrypts on serve |

TURN credentials are fetched at p2p-manager init time, not at connection establishment. They are cached in memory for 1 hour and refreshed automatically 5 minutes before the TTL expires. This avoids latency spikes at connection time and handles long-running sessions.

---

## Signaling State Persistence

Signaling state (room node registry and message queue) is stored in the following priority order:

| Priority | Driver | Condition |
|----------|--------|-----------|
| 1 | Supabase `beta_logs` table | `SUPABASE_URL` + `SUPABASE_SECRET_KEY` set; `NODEX_BETA_STORAGE_DRIVER=supabase` (or auto-detect) |
| 2 | Vercel Blob | `BLOB_READ_WRITE_TOKEN` set |
| 3 | In-memory `Map` | Fallback only — does not survive Vercel function cold starts |

**For the hosted beta, Supabase is the required persistence layer.** Without it, nodes that land on different Vercel function instances will not see each other, and P2P connections will fail to establish.

If Supabase goes down, the signaling falls back to in-memory, which works only when all signaling requests hit the same warm function instance. This is not reliable under load.

---

## Verifying a Deployment

Run this sequence after every deploy to both projects.

```bash
# 1. Confirm API is live and auth is enforced
curl -s https://nodex-beta-api.vercel.app/api/session-key
# Expected: {"error":"unauthorized"}

# 2. Confirm TURN endpoint enforces auth
curl -s https://nodex-beta-api.vercel.app/api/turn-credentials
# Expected: {"error":"unauthorized"}

# 3. Confirm a valid token returns a session key
curl -s -H "Authorization: Bearer nodex-tester-b27babb8559e48138830a7f743320b41" \
  https://nodex-beta-api.vercel.app/api/session-key
# Expected: {"keyId":"default","keyBytes":"<base64 string>"}

# 4. Confirm a valid token returns TURN servers
curl -s -H "Authorization: Bearer nodex-tester-b27babb8559e48138830a7f743320b41" \
  https://nodex-beta-api.vercel.app/api/turn-credentials
# Expected: {"iceServers":[{"urls":"stun:..."},{"urls":"turn:...","username":"...","credential":"..."}],"expiresAt":<unix timestamp>}

# 5. Confirm gossip-seed requires auth
curl -s -X POST https://nodex-beta-api.vercel.app/api/signal/gossip-seed \
  -H "Content-Type: application/json" \
  -d '{"roomId":"probe","key":"/api/products/1","seq":1}'
# Expected: {"error":"unauthorized"}

# 6. Confirm no TURN credentials are hardcoded in built assets
grep -r "openrelay" apps/beta-suite/public/assets/
# Expected: no output

# 7. Run unit tests
npx vitest run
# Expected: 134/134 passed (or current passing count)

# 8. Confirm frontend rewrite works
curl -s https://nodex-beta.vercel.app/api/session-key
# Expected: {"error":"unauthorized"}
# (Same response as step 1 — proves the Next.js rewrite is forwarding correctly)
```

All 8 checks must pass before considering a deployment healthy.

---

## Troubleshooting

### P2P connections fail on 4G or mobile networks (relay path not selected)

**Symptom:** Tester on a mobile connection sees no peer connections established, or `selected_candidate_type` in evidence shows `host` or `srflx` rather than `relay`.

**Diagnosis:**

```bash
curl -s -H "Authorization: Bearer nodex-tester-<hash>" \
  https://nodex-beta-api.vercel.app/api/turn-credentials
```

If this returns `{"error":"unauthorized"}` or an empty `iceServers` array, the TURN env vars are not set or the deploy did not pick them up.

**Fix:**

1. Verify `NODEX_TURN_URLS`, `NODEX_TURN_USERNAME`, and `NODEX_TURN_CREDENTIAL` are set on `nodex-beta-api` (Vercel dashboard → Environment Variables → Production).
2. Redeploy: `vercel link --yes --project nodex-beta-api && vercel --prod`
3. Re-run the verification curl above and confirm the response includes TURN entries.

---

### Products appear encrypted or blank after a session key fetch

**Symptom:** The product list in the beta dashboard shows garbled text, empty cards, or a decryption error in the browser console.

**Diagnosis:** Open DevTools in the `metrics.html` iframe context. Look for:

```
[p2p] session key fetch failed: <error>
[sw] decrypt error: <error>
```

**Fix:**

1. Verify `NODEX_SESSION_KEY_HEX` is set on `nodex-beta-api` and is exactly 64 hex characters:
   ```bash
   # Count characters: should print 64
   echo -n "your-hex-value-here" | wc -c
   ```
2. The key used to encrypt products in `api/products/[id].ts` must be the same key stored in `NODEX_SESSION_KEY_HEX`. If you regenerated the key, redeploy both and clear the browser's Service Worker cache (DevTools → Application → Storage → Clear site data).
3. Redeploy after any key change: `vercel link --yes --project nodex-beta-api && vercel --prod`

---

### Nodes do not discover each other (signaling state not persisting)

**Symptom:** Two testers in the same room never see each other as peers, even after waiting 10–15 seconds.

**Diagnosis:**

1. Check Vercel function logs for `nodex-beta-api` (Vercel dashboard → Functions → Logs):
   ```
   [signal] Supabase state write failed: <error>
   [signal] using in-memory state (cold start)
   ```
2. If both messages appear, Supabase is not reachable and signaling is running in-memory — requests hitting different function instances cannot share state.

**Fix:**

1. Verify `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are correct. Test connectivity:
   ```bash
   curl -s -H "apikey: <service-role-key>" \
     -H "Authorization: Bearer <service-role-key>" \
     "https://<project-id>.supabase.co/rest/v1/beta_logs?limit=1"
   ```
   Expected: an empty JSON array `[]` or a list of log entries.

2. If Supabase credentials are wrong, update them in Vercel and redeploy.
3. If Supabase is down, wait for recovery — in-memory signaling is not a viable fallback for multi-node sessions.

---

### 429 Too Many Requests

**Symptom:** Tester actions return HTTP 429 with a rate-limit error.

**Context:** The edge middleware on `nodex-beta` (Next.js) enforces:
- 120 requests/minute per IP for general API calls
- 20 requests/minute per token for auth-sensitive endpoints

At typical beta scale (2–3 simultaneous testers), this limit should not be reached during normal use.

**Fix:**

1. Wait 60 seconds. The rate-limit window is a sliding 60-second window and resets automatically.
2. If a tester hits limits during a test run, check whether any client-side code is in a retry loop — a misconfigured retry could exhaust the budget quickly.
3. Note: direct calls to `nodex-beta-api.vercel.app` bypass the edge middleware. Rate limits only apply to requests routed through `nodex-beta.vercel.app`.

---

### `{"error":"unauthorized"}` with a token that should be valid

**Symptom:** A `curl` test or browser request returns `{"error":"unauthorized"}` despite using a token that was recently generated.

**Possible causes and fixes:**

| Cause | Fix |
|-------|-----|
| Token not in `NODEX_BETA_TOKENS` env var | Add it and redeploy `nodex-beta-api` |
| Token missing the `\|Name\|\|Note` suffix | Token format must be `nodex-tester-<hash>\|Name\|\|Note`, not just the token string |
| Token added after the last deploy | Vercel does not hot-reload env vars — redeploy after any env change |
| Token does not start with `nodex-tester-` | Regenerate with the correct prefix |
| Trailing whitespace or newline in the env var value | Edit the env var in Vercel dashboard and remove any trailing characters |

**Quick verification:**

```bash
curl -v -H "Authorization: Bearer nodex-tester-<hash>" \
  https://nodex-beta-api.vercel.app/api/session-key
```

A 200 response with `{"keyId":"default","keyBytes":"..."}` confirms the token is valid and the deployment picked it up.

---

### Service Worker not registering in metrics.html

**Symptom:** No cache hits are recorded, and the DevTools Application → Service Workers panel shows no active SW for the `metrics.html` origin.

**Possible causes:**

1. The built asset hash in `metrics.html` does not match the files in `apps/beta-suite/public/assets/`. This happens when `npm run build` was run but `npx tsx scripts/sync-beta-runtime.ts` was not.

   **Fix:** Run the sync script and redeploy the frontend:
   ```bash
   npx tsx scripts/sync-beta-runtime.ts
   vercel link --yes --project nodex-beta && vercel --prod
   ```

2. The browser has a stale SW registration from a previous build. **Fix:** Clear site data in DevTools (Application → Storage → Clear site data) and reload.

3. HTTPS is required for Service Worker registration. `metrics.html` served over `http://` will not register the SW. Vercel deployments are always HTTPS — this is only a risk in local dev. Use `vercel dev` rather than `vite preview` to avoid this.

---

### Checking Vercel function logs

For any API-side issue, Vercel function logs are the primary diagnostic tool.

```bash
# Tail live logs for the API project
vercel link --yes --project nodex-beta-api
vercel logs --follow
```

Or use the Vercel dashboard: select the project → Functions tab → select a function → view logs.

---

## Quick Reference: Key Commands

```bash
# Generate a session key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate an admin token
node -e "console.log('nodex-admin-' + require('crypto').randomBytes(16).toString('hex'))"

# Generate a tester token
node -e "console.log('nodex-tester-' + require('crypto').randomBytes(16).toString('hex'))"

# Build core source
npm run build

# Sync runtime assets into frontend
npx tsx scripts/sync-beta-runtime.ts

# Deploy API
vercel link --yes --project nodex-beta-api && vercel --prod

# Deploy frontend
vercel link --yes --project nodex-beta && vercel --prod

# Run unit tests
npx vitest run

# Tail API logs
vercel link --yes --project nodex-beta-api && vercel logs --follow

# Check auth is working (replace token)
curl -s -H "Authorization: Bearer nodex-tester-<hash>" \
  https://nodex-beta-api.vercel.app/api/session-key

# Check TURN credentials are served (replace token)
curl -s -H "Authorization: Bearer nodex-tester-<hash>" \
  https://nodex-beta-api.vercel.app/api/turn-credentials
```
