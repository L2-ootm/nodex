# Nodex

Nodex is an experimental browser cache for globally public, frequently read snapshots. A Service Worker verifies publisher signatures, decrypts responses and chooses local cache, a WebRTC peer or the origin. The beta suite records what actually happened.

The current repair branch replaces several unsafe PoC contracts. It is suitable for local evaluation; it has not been released or certified against deployed Supabase, WAN/NAT, mobile suspension, live TURN or provider bills. Historical reports describe their original revisions and do not establish the current release status.

## Run locally

Use Node.js 24 and install the lockfile dependencies:

```powershell
npm ci
npx playwright install chromium
npm run beta:local
```

Open `http://localhost:4174`. The local tester invitation is `nodex-tester-local-development`; the local administrator invitation is `nodex-admin-local-development`. These credentials belong only to the loopback development stack. The command builds the protocol runtime and starts the complete API on port 3003 and Next on port 4174. It does not require Supabase. Environment files must be loaded by your shell or host; Next reads its own project environment. See [.env.example](.env.example).

The guided run compares the same ordered keys, versions and payload digests across origin-only, local-cache and automatic delivery. A solo run is partial. A P2P result requires an attributed peer delivery. A tester cannot publish invalidations. The evidence download includes raw read and control observations; financial savings remain unmeasured without calibration.

## Verify

```powershell
npm run typecheck
npm run test:unit
npm run test:beta-next
npm run test:beta-real
npm test
npm audit
```

`test:beta-next` uses UI fixtures. `test:beta-real` uses real loopback APIs, encryption, HTTP signaling, Service Workers and persistence. The root browser suite (`npm test`) includes the legacy WebSocket research harness and `tests/beta-web.spec.ts`, which uses route mocks and is therefore not evidence of real-server behavior. Build rejects a Service Worker that cannot run as a classic script or exceeds its 50 KiB gzip budget. Browser tests use isolated API ports; ports 4173, 4175 and 4176 must be free. Run suites sequentially because builds share artifacts.

## Protocol contract

Only `/api/products/<one alphanumeric, underscore or hyphen ID>` opts into shared reuse. The payload must be globally identical for that resource across readers. Query, authorization and explicit cookie-header requests bypass shared reuse. Native cookie headers are not generally observable by a Service Worker: never use these public routes for cookie-dependent content. Private/no-store responses and responses varying by cookies, authorization, language or `*` cannot enter the shared pool. Signed public scope is mandatory; CORS/compression variation is permitted.

Publisher P-256 signatures authenticate resource, tenant, authority epoch, version, scope, ciphertext and validity. AES-GCM reader keys provide confidentiality, not permission to publish. Public reuse proves recent publication within five seconds; it does not promise linearizable reads or immediate knowledge of every concurrent write. When durable browser storage is available, verified public versions and invalidations establish monotonic barriers within an authority epoch. Otherwise only origin delivery remains available with an explicit volatile-consistency header. A trusted origin epoch transition resets Nodex content and barriers while preserving unrelated application caches.

Writes use an administrator credential, an `Idempotency-Key` UUID and `{ baseVersion, data }`. `POST /api/write/api/products/1` commits payload, version, retry identity and outbox atomically. Stale or future bases return 409. Invalidation accepts `/api/invalidate/products/1` or `/api/invalidate/api/products/1`; `queued` means durable publication is pending, not delivered. The outbox worker performs eventual delivery with lease fencing.

## Operation and evidence

[OPERATIONS.md](OPERATIONS.md) describes production configuration, database migration, key rotation, privacy, failure recovery and economic calibration. [REPAIR_VALIDATION.md](REPAIR_VALIDATION.md) maps repaired audit findings to checks and records the limits of those checks.

The product hypothesis is that shared snapshots can avoid additional origin work beyond a normal browser cache. Cache hit rate alone cannot establish that hypothesis or financial savings. The beta exports a controlled local comparison; adoption, a CDN baseline and billed net savings per hour still need a real pilot.

Research reports and `research/` remain historical source material. Original quarantined GSD packages must not be executed as part of this project's workflow.
