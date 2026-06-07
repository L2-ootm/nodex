# Consistency Instrumentation Report — 2026-06-03

## What changed this session

### 1. `src/shared/types.ts`
- Added `'admission-rejected'` to `MetricsEvent.type` union.
- Added `rejection_reason?: string` and `rejection_source?: 'cache' | 'peer'` to `MetricsEvent`.
- Added `ice_gather_duration_ms?`, `dc_open_latency_ms?`, `signaling_success?` to `PeerTelemetrySample`.

### 2. `src/sw/metrics.ts`
- Extended `emitMetric()` to accept optional `rejection_reason` and `rejection_source` params, merged into the emitted event.

### 3. `src/sw/sw.ts` — Consistency admission gate wired
- Added `observedVersionMap: Map<string, number>` — in-memory session observed-version barrier (`obs_s(key)`, Def. 4.2 of FORMAL_SYSTEM_MODEL.md).
- Added `peerReadsPolicyFromScore(score)` — maps volatility score to `ConsistencyPolicy`. Score >= `VOL_P2P_GATE` (0.8) returns `class: 'critical', peerReads: false`. Score below returns `class: 'fresh-dynamic', peerReads: true, maxStaleVersions: 3`.
- **Cache hit path (`handleRequest`):** After `isFresh()` passes, calls `admitCandidate()` with obs_s barrier. Rejection → emit `admission-rejected` metric + fall through to server. Admission → advance obs_s via `observeVersion()`, then proceed to decrypt + return.
- **Peer-fetch path (`tryPeerFetch`):** After `isFresh()` check and before AES decrypt, calls `admitCandidate()`. Rejection → emit `admission-rejected` metric + `resolve(null)` (falls through to server). Admission → proceed with decrypt; obs_s advanced after successful decrypt.
- **Server-fetch path (`fetchAndCache`):** After `updateSeq()`, also calls `observeVersion()` to advance obs_s from authoritative server response.

### 4. `src/shared/consistency.ts` (unchanged)
- `admitCandidate()` and `observeVersion()` already implemented in prior session. No changes needed.

### 5. `src/shared/consistency.test.ts` (unchanged)
- 8 tests covering RYW, monotonic reads, version staleness, time staleness, class-forbidden, missing-policy, hash-invalid, and observeVersion monotonicity. All pass.

---

## What claim this supports

**Allowed now:**
> Nodex has an executable, tested consistency admission contract (`admitCandidate()`) wired into both the SW cache hit path and the P2P peer-fetch path. Session read-your-writes and monotonic reads are enforced via an in-memory observed-version barrier (`observedVersionMap`). Admission rejections are metered via `admission-rejected` metrics with rejection source and reason.

**Still hypothesis / design-goal:**
> The obs_s barrier is in-memory only. It resets on SW restart (browser close, SW update). Durability across SW restarts requires IDB persistence (a separate store or a `'__obs_versions'` sentinel in `nodex-meta`). This is not implemented and documented as a known PoC limitation.
>
> The `peerReadsPolicyFromScore()` policy is a proxy derived from the volatility score. A production system would attach `class` metadata directly to each server response (e.g., `X-Nodex-Class` header) so the policy is server-authoritative, not inferred.
>
> The `updatedAt` field passed to `admitCandidate()` for cache hits uses `meta.cached_at ?? meta.accessed_at` as an approximation of server commit time. This is imprecise — `cached_at` is when we cached it, not when the server committed it. `maxStaleMs` is not set in the default policy to avoid false positives from this approximation.

---

## What remains

| Item | Status | Priority |
|---|---|---|
| Persist obs_s across SW restarts in IDB | Design-goal | Post-PoC |
| Server-issued `X-Nodex-Class` header for authoritative policy | Design-goal | Phase 19 |
| `maxStaleMs` enforcement with server commit timestamps | Design-goal | Phase 19 |
| Add `class` field to `CacheMeta` stored in IDB | Design-goal | Phase 19 |
| Measure admission rejection rate in Playwright harness | Deferred | Phase 22 |

---

## Evidence produced

- `npm run typecheck` passed.
- `npx vitest run src/shared/consistency.test.ts` — 8 tests, all pass.
- `npx vitest run` (full suite) — 155 tests, 0 failures.

---

## What could still break

- If `scoreCache.get(key)` returns a score that differs from what the caller expected at the time of the cache write, the policy for the same entry may differ between cache-write and cache-read time. This is acceptable: the policy is always based on the most current score, which is the correct behavior.
- `obs_s` resets on SW restart. Any session that spans a SW update will lose the monotonicity guarantee across the restart boundary. This is a documented PoC limitation.
- If `meta.cached_at` is undefined (stable entries written without TTL), `meta.accessed_at` is used as fallback. This may be significantly later than the server commit time if the entry was frequently accessed. Since `maxStaleMs` is not set in the default policy, this fallback does not cause incorrect rejections.

---

## Next smallest safe step

Implement persistent obs_s via a `'__obs_versions'` sentinel key in `nodex-meta` IDB store, seeded on SW activation and updated on every `observeVersion()` call. This upgrades the session guarantee from "SW lifetime" to "browser context lifetime".
