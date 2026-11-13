# Repair validation

Scope: repair of audit F01–F21 against base `fc90d6f2dab9bdacfe31ebd59edf8791d8ee5b63`, on branch `codex/nodex-defensible`. These results establish local contracts, not a production release, customer adoption or billed savings. Historical audit probes describe the original revision; the maintained tests below exercise the repaired contracts.

## Acceptance matrix

| Finding | Implemented contract | Maintained evidence |
| --- | --- | --- |
| F01 overlapping delivery | Recheck admission and publisher domain after awaits; cache writes cannot replace newer versions. | `tests/helpers/sw-safety.test.ts`, `tests/helpers/cache-budget.test.ts` |
| F02 invalid ciphertext promotes state | Verify publisher proof and AES before cache, barriers or successful delivery metrics. | `tests/helpers/sw-safety.test.ts`, `src/crypto/publisher-proof.test.ts` |
| F03 worker restart loses barriers | Boot reads durable observed/invalidation state on every worker process. Storage failure disables shared reuse and exposes volatile origin delivery. | `tests/helpers/sw-safety.test.ts`, `tests/sw-origin-regression.spec.ts` |
| F04 representation mixing | Only explicit globally public product snapshots enter reuse; query/auth/private/no-store and unsafe Vary variants bypass it. Private reads cannot promote public barriers. | `tests/helpers/sw-safety.test.ts`, `tests/sw-intercept.spec.ts` |
| F05 missing IV accepts plaintext | Require signed encrypted envelope, IV and matching encryption key identity. | `tests/helpers/sw-safety.test.ts` |
| F06 foreign cache deletion | Activation deletes only obsolete Nodex caches. | `tests/helpers/sw-safety.test.ts`, `tests/sw-lifecycle.spec.ts` |
| F07 inconsistent versions | Validate safe positive read/invalidation versions and exact nonnegative write bases across boundaries. | `src/shared/config.test.ts`, authority/API tests, SQL contracts |
| F08 unsigned gossip poisoning | Proof verification precedes promotion; unsigned gossip is a bounded origin refresh hint. | `tests/helpers/sw-safety.test.ts`, `src/gossip/gossip-engine.test.ts` |
| F09 incompatible outbox sink | Preserve signaling URL prefix, authenticate service seeds, stable event identity and durable queued acknowledgment. | `api/signal/hosted-contracts.test.ts`, `tests/helpers/invalidate-route.test.ts`, outbox worker tests |
| F10 seed outside polled queue | Atomic signaling RPC inserts service seeds into the same ordered queue polled by peers. Production signing rejects future authority versions. | `api/signal/hosted-contracts.test.ts`, `api/signal/publication-safety.test.ts`, migration `20261002000100_atomic_signaling.sql` |
| F11 concurrent presence/cursors | Registered node grants, atomic joins, monotonic queue cursor and configured presence adapter. | `api/signal/hosted-contracts.test.ts`, beta coordinator tests, SQL migration/contracts |
| F12 false persistence success | Hosted storage errors return unavailable; no implicit memory or Blob authority fallback. | `api/signal/hosted-contracts.test.ts`, authority tests, beta configuration tests |
| F13 sender spoofing | HTTP messages require node grants bound to authorized joins; WS binds sender to joined connection and restricts service broadcast. | `api/signal/hosted-contracts.test.ts`, signaling/API tests |
| F14 incompatible beta invitation | Stored, active invitations authorize protocol endpoints; direct hash lookup supports large invite tables; revocation remains effective. | `api/lib/auth.test.ts`, `src/server/beta-coordinator.test.ts`, `tests/beta-real.spec.ts` |
| F15 null/invalid JSON | Reject malformed bodies at boundaries with client errors. | signaling, authentication, write and coordinator tests |
| F16 non-atomic invite limits | Enrollment locks/checks the invitation and commits participant/session/usage atomically; local adapter uses a serialized atomic snapshot. | `src/server/beta-coordinator.test.ts`, `supabase/tests/beta_and_lease_contracts.sql` |
| F17 peer deadline/correlation | Deadline includes verification/storage; only positive peer replies win; cap pending requests, connections, frames and backpressure; expire unanswered requests. | `tests/helpers/sw-safety.test.ts`, `src/p2p/p2p-manager.test.ts`, root browser suites |
| F18 AES reader can publish | Publisher-only P-256 signature covers ciphertext and metadata; reader receives public verification key only. AES is confidentiality, not publisher authorization. | `src/crypto/publisher-proof.test.ts`, SW safety tests, `tests/beta-real.spec.ts` |
| F19 future OCC/ignored payload | Exact base equality, canonical payload, retry identity and atomic payload/version/outbox commit; reads return committed data. | authority tests, `api/write/snapshot.test.ts`, `supabase/tests/snapshot_contracts.sql` |
| F20 SVG injection | Escape participant names before SVG markup. | `src/dashboard/beta.test.ts` |
| F21 duplicate/missing measurements | Stable delivery IDs, transactional buffers, deduplication, SDK attribution, ordered matched workloads and control coverage gate. | metric dedup tests, economic ledger tests, beta adoption tests, real browser run |
| F22 wall-clock freshness reference | Freshness windows use an origin-anchored monotonic clock (`src/sw/trusted-clock.ts`); only a no-store origin response may anchor, the anchor never moves backward, peers/signaling/cache never anchor, and until anchored origin fetches bypass HTTP caches. Not covered: SW restart loses the anchor (falls back to wall clock); `p2p-manager.ts:100` page-side invalidation check still uses wall clock; `cache:'no-store'` does not bypass a CDN edge. | `src/sw/trusted-clock.test.ts`, `tests/helpers/sw-safety.test.ts` (client clock +/-60 s, cache-mode before/after anchor) |
| F17 caps (test gap closed) | 128 pending requests and 262,144 buffered bytes are named constants and asserted. | `src/p2p/p2p-manager.test.ts` |
| F23 no rate limit on hosted signal, TURN and session-key routes | Per-credential fixed-window limiter (`api/lib/rate-limit.ts`) before authentication: join/leave 30, send 120, poll 180, TURN 20, session-key 30 per minute; 429 with Retry-After; bounded memory. Limit is per serverless instance, so the effective ceiling is limit x instances; a shared store is required for a hard global ceiling. | `api/lib/rate-limit.test.ts`, `api/signal/rate-limit-route.test.ts` |

## Additional defects corrected during repair

- Concurrent HTTP discovery now assigns opposite negotiation roles deterministically. Two isolated real browsers connect and perform a signed peer read. A deterministic failure-handler check verifies two ICE restarts then closure and cleanup of only that peer's pending requests; it does not prove network recovery.
- Vite's dynamic-import DOM helper prevented classic Service Worker startup. The import was removed and every runtime build now checks classic-script syntax and a 50 KiB gzip budget.
- Explicit authority epochs fence overlapping reads and queued writes. Ephemeral development authorities receive distinct epochs; AES key IDs derive from key material. Production rejects missing/invalid publisher tenant and epoch configuration. A restarted worker recovers its reader key from an authorized controlled page with a bounded reply deadline, without persisting the invitation. A real Chromium worker-stop test checks this while anonymous key access returns 401.
- Outbox leases use fresh owners per claimed batch and reject acknowledgment/retry after expiry. SQL contracts cover expiry, ownership and rollback.
- Streamed cache accounting enforces 10 MiB and 500 entries; failed metadata persistence removes unaccounted bodies. Other bounded state includes peer connections, unsigned refresh hints and imported AES keys.
- Guided evidence requires actual attributed delivery. A solo run remains partial. Missing/truncated/control-worker coverage prevents financial estimates; calibrated estimates remain qualified observations, not billed savings.
- Complete local beta command builds its runtime and serves protocol, HTTP signaling, coordinator and Next. Generated browser artifacts are rebuilt and excluded from source control.

## Verification performed

| Check | Result and scope |
| --- | --- |
| `npm run typecheck` | Passed root, SW, server/API/scripts and Next checks. |
| `npm run test:unit` | 340 tests passed across 49 files (2026-11-13 re-verification), including publisher configuration, SW concurrency/storage/key recovery and explicit economic-coverage regressions. |
| Root Chromium suite (`npm test`) | 57 passed; one pre-existing ICE-restart scenario remains skipped. |
| `npm run test:beta-next` | 7 passed with UI fixtures; not protocol proof. |
| `npm run test:beta-real` | 3 passed (re-run 2026-11-13, twice consecutively after making the suite reset its own data directory; before that fix a second run on the same directory failed at evidence submit with a stale session) using real loopback API, encryption, HTTP signaling, SW and local persistence; includes two-browser peer delivery and worker-stop key recovery with authorized key access. |
| Runtime/Next builds | Passed through the browser harness. Built SW classic-script check passed; gzip 9,357 bytes at the final runtime measurement. |
| `npm audit` | 2026-11-13: 8 remaining (2 low, 6 moderate, none high). `hono` 4.13.18 and `npm audit fix` cleared the high `undici` advisory. Remaining: build-time `workbox`/`glob`/`minimatch`/`deepmerge` chain (fix offered is a downgrade) and `@hono/node-server` (major; `serveStatic` is not used in this repo, second advisory not yet assessed). Earlier zero-vulnerability result is superseded. |
| PostgreSQL/WASM migration execution | All eight migrations applied and reapplied; 15 harness assertions plus both permanent SQL contract files passed. One connection; not deployed Supabase. |
| Key/config tools | Exclusive key-file creation and duplicate-write rejection passed. Production structural validation passed with offline synthetic service configuration; no live credential or network validation. |
| Documented local command | `npm run beta:local` started successfully; app, SW, metrics runtime, signed product route and publisher identity returned 200 through Next. Owned processes stopped afterward. |

SQL checks are committed in `supabase/tests/`. Apply migrations in filename order to an isolated test database, then run both contract files with error-stop enabled. They use rollback to discard test data. The isolated PostgreSQL/WASM harness used for this review is not a production dependency.

## Remaining release evidence

The public route must actually be globally identical across readers; native cookie headers are not generally observable in a SW. Five-second public proof freshness and monotonic barriers do not imply linearizability or immediate write visibility. Browser storage failure reduces the guarantee explicitly. Invitation authorization does not verify a person's real identity; tester nicknames and manually submitted outcomes remain self-reported.

Before a hosted pilot, apply migrations to the dedicated Supabase project and verify deployed PostgREST permissions, concurrent instances, outbox recovery and the commit-gated deployed browser smoke. Then test WAN/NAT, actual TURN relay and credentials, mobile suspension, failure recovery and latency with real participants. None of those environments was configured during this local repair. The skipped ICE-restart test cannot support a reconnect claim.

Before an economic claim, collect a real workload and CDN/browser-cache baseline, calibrated provider costs, relay/database/control costs and a matched net savings calculation per observed hour. The current result is an exportable measurement mechanism and a product hypothesis. Adoption, revenue, legal defensibility and paid savings have not been demonstrated. Operational setup and failure handling are in `OPERATIONS.md`.
