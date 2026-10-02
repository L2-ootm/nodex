# Operation and pilot contract

## Local evaluation

`npm run beta:local` serves the complete loopback API at port 3003 and Next at port 4174. Protocol reads and HTTP signaling are available in that API process; a separate WebSocket process is unnecessary. Default development invitations are printed in README. Local files live under ignored `beta-data/`. They are not a production database.

`npm run dev` serves the research dashboard. Its Service Worker needs a built runtime, so use `npm run build` followed by `npx vite preview --port 4173` when evaluating cache behavior. The root Playwright configuration starts the matching API and signaling servers automatically.

Run browser suites sequentially. They rebuild shared artifacts. The real beta integration suite uses API port 33003 and Next port 4176; the root research suite uses API port 33001 and preview port 4173. An unrelated listener on port 3001 is not stopped by the harness.

## Production preparation

The API project owns SQL access, signing and encryption secrets. Next owns the tester interface and proxies public protocol routes to `NEXT_PUBLIC_NODEX_BETA_API_URL`. Its mutation proxy forwards the administrator credential; it does not store SQL secrets. This public API URL must be fixed by the deployment, never selected from a request body.

1. Install with `npm ci`. Apply every `supabase/migrations/*.sql` in filename order to a dedicated database, using the migration administrator. Do not enable anonymous access to the protocol or beta tables. The server uses the service role.
2. Run `npm run keys:generate` to create an exclusive ignored `.env.keys.local`. Import its values into the API and outbox worker secret stores. It never prints private material or replaces an existing file. Restrict the file with OS permissions, especially on Windows, and remove it after importing if appropriate.
3. Configure the fields in `.env.example`: both storage drivers must be `supabase`, tenant must be a UUID, publisher JWK must be private P-256, epoch must be explicit, AES key must be 32 bytes, and administrator/service tokens must be strong. Use HTTPS API, app and signaling URLs. Never expose these secrets through `NEXT_PUBLIC_*` or `VITE_*`.
4. Set `NODEX_BETA_SIGNALING_HTTP_URL=https://API.example/api/signal` for the worker and the same `/api/signal` base as `NODEX_BETA_SIGNALING_URL`. The sink preserves this prefix. Run `npm run outbox:worker` as a supervised process with the API's tenant and service seed credential.
5. Load the production environment and run `npm run config:production`. This is a local structural check, not a database or deployed routing probe. Then build with `npm run beta:next:build`, deploy the API and app together and run the existing commit-gated deployed smoke against those revisions.

The local development stack rejects production mode and hosted database configuration. Production sequence, beta and signaling adapters fail closed on unavailable storage. There is no silent in-memory or Blob authority fallback. The original Blob ledger path is retained only for historical tooling, not a supported hosted mode.

## Data and identity

Keep an authority epoch stable across application restarts and signing-key rotations while the SQL version history remains intact. Change it only when intentionally replacing that history. Browsers bind an epoch through the same-origin publisher-key endpoint; peer-provided keys cannot authorize a reset. A distinct ephemeral development publisher gets a distinct epoch on restart. AES key IDs derive from key material, preventing a rotated key from selecting a stale browser import.

Legacy browser databases without a publisher-domain sentinel preserve existing barriers on their first binding. When migrating an old prototype with incompatible or reset counters, explicitly reset only Nodex's cache and IndexedDB in that test profile; this is a new consistency session. Do not delete other applications' caches.

Publisher proofs expire after five seconds for content and two minutes for invalidations. Maintain synchronized origin and client clocks; no clock-skew correction protocol is implemented. Local cache or peer data that no longer meets the proof window falls back to the origin. The protocol promises a bounded publication window and monotonic public versions within an epoch, not linearizability.

All opted-in product paths must return globally public snapshots independent of cookies, locale or reader identity. A Service Worker cannot reliably inspect ambient Cookie headers. Put personalized resources outside this route contract and mark them private/no-store. A reader with the AES key can read the public pool but cannot create a publisher signature.

The beta key endpoint requires an invitation. An authorized page imports its reader key and retains it only in page memory. If the browser restarts the worker without changing its controller, the worker requests that key from controlled pages within a bounded reply deadline. The invitation is not stored in worker metadata. Key rotation can trigger an authenticated page refresh; if no authorized page can supply the key and the endpoint refuses anonymous access, decryption fails closed. This is not immediate revocation of a key already given to a reader.

Writes and bumps commit a durable invalidation outbox event. A `queued` API result is not propagation acknowledgment. Expired leases cannot acknowledge or reschedule work; every claimed batch receives a fresh owner nonce. Worker retries are at least once, so event IDs must remain idempotent. Monitor pending age, attempts, lease loss and sink failures. Stop/restart a crashed worker; do not skip undelivered rows to make a dashboard appear green.

Local enrollment and token mutations share a bounded directory lock and atomic file replacement. A crashed local process may leave `.nodex-enrollment-lock`; remove that lock only after confirming no local writer remains. Hosted enrollment uses SQL locks and transactions instead.

Presence/signaling expire logically. Establish scheduled retention for expired presence, old signal messages, delivered outbox events, logs and evidence according to the pilot's data policy. Preserve pending outbox work and required research evidence. The migrations enforce access and atomicity; they do not install a retention scheduler.

## Connectivity and cost

HTTP signaling has one in-flight poll, bounded request timeouts and reconnect backoff. Connected/idle nodes poll every 15 seconds. Outbound discovery selects a small peer set; inbound connections are capped at 12. Peer delivery has a 200 ms complete deadline and falls back to origin. This may favor fallback on distant or suspended devices; measure that behavior before expanding topology claims.

TURN is optional. Set `NODEX_TURN_URLS` and `NODEX_TURN_SHARED_SECRET` to use timed coturn REST credentials; the server must use the corresponding [coturn shared-secret configuration](https://github.com/coturn/coturn/wiki/turnserver). Static credentials require explicit `NODEX_ALLOW_STATIC_TURN=true` in production and report no invented expiry. Issuing credentials does not prove that the relay accepts them or that relay usage is economical.

Next's bounded request limiter is a per-process guard. It is not a distributed abuse budget. Configure platform limits and supervise the worker for an external pilot; record their cost. Browser control observations measure application bodies, excluding HTTP/TLS framing, compression, database work and provider billing.

## Economics and adoption

Download the guided evidence JSON and run `npm run economics:evaluate -- evidence.json`. A matched workload requires the same ordered resource/version/digest reads across origin, local-cache and automatic arms. Request IDs prevent duplicate delivery credit. P2P credit is evaluated against the local-cache arm; a local-cache hit displaced by a peer saves no additional origin request.

An optional calibrated price JSON supplies `originRequestUsd`, `controlRequestUsd`, `measuredRelayAndDatabaseUsd`, `otherIncrementalUsd` and `calibrationReference`. All incremental costs must describe the same observation interval. Even with those inputs, the result is an estimate per observed browser hour. Missing, truncated, conflicting or lost control observations suppress the estimate. It remains an unverified economic claim until reconciled with bills.

For a defensible pilot, recruit a narrowly defined repeated-read use case, compare against its actual browser/CDN configuration, randomize the assigned path, keep version/payload and latency quality equal, and reconcile avoided origin work with control, relay, RPC, CPU and operational expense. Measure onboarding completion and repeated use as adoption outcomes. The short sequential beta run is a debugging and measurement artifact; it does not establish those customer outcomes.

## Validation limits

Automated browser checks establish loopback behavior in Chromium. PostgreSQL/WASM checks execute and reapply SQL and assert rollback/contracts on one connection. Neither proves hosted PostgREST permissions in the deployed project, cross-instance scheduling, real WAN/NAT, TURN acceptance, mobile suspension, geographic reach, bills, adoption or legal defensibility. Historical technical and legal-attribution reports retain their own scope and revision.
