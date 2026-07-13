# Nodex

Nodex is a browser-native P2P distributed dynamic cache proof of concept. Browser clients act as encrypted cache nodes through Service Workers and WebRTC DataChannels; invalidation propagates through server-sequenced gossip; a lightweight volatility heuristic controls cache/P2P eligibility.

## Status

v1.0 PoC milestone complete as of 2026-05-23. Phase 7 external-validity harness execution is complete as of 2026-05-24, with manual external-network UAT still pending.

Hosted beta validation update, 2026-05-27:

- `https://nodex-beta.vercel.app` now serves the Next.js beta suite plus the real Vite protocol runtime at `/metrics.html` and `/sw.js`.
- `https://nodex-beta-api.vercel.app` now serves the beta control plane and HTTP signaling fallback at `/api/signal/*`.
- Production smoke opened two isolated browser contexts against the hosted site, formed a WebRTC edge through deployed HTTP signaling, seeded `/api/products/1` on node A, and observed node B serve the same key with `peer-fetch: 1`.
- Latest production deployment IDs: web `dpl_A6ZJmtFwBDxyN1gMfAdA6nxfGfr6`; backend `dpl_HEbGrpaq9yyb5zr95oCctSENgwE2`.

Beta readiness forensics update, 2026-05-31 (historical):

- Do not start broad external beta yet. `docs/qa/nodex-forensics-beta-readiness-2026-05-31.md` found the then-current hosted deployed P2P smoke failing with `mesh connection timeout; counts=0,0`.
- The same forensics pass found `npm run validate:external` failing in EXT-05 at `POST /api/gossip-seed`.
- New v1.3 recovery milestone added as Phases 13-16: hosted P2P smoke recovery, churn/rejoin freshness recovery, tester UX/evidence reliability, and beta release candidate/evidence hygiene.

Interphase execution update, 2026-06-17:

- Local interphase gates pass after the concurrent-discovery fix: `npm run typecheck`, `npm run test:unit` (178/178), `npm run beta:next:build`, `npm run test:beta-next`, and `npm run validate:external`.
- Hosted deployed smoke evidence is mixed. A sequential 2026-06-17 run formed a WebRTC edge and observed `peer-fetch: 1`, but a later diagnostic rerun timed out with `mesh connection timeout; counts=0,0` against the still-deployed runtime. Treat `npm run verify:deployed-p2p` as pending/flaky until the interphase runtime and API changes are deployed and rerun.
- Interphase Phase 1 has started: HTTP signaling polls now heartbeat presence and return active peers, and the browser P2P manager consumes poll-discovered peers through `PEERS_LIST`.
- Broad beta remains claim-gated. The current evidence does not prove WAN/NAT, forced TURN, mobile browser, background-tab behavior, geographic long-range topology, or a stable hosted concurrent-join gate.

Final local-loopback validation:

- 96 Vitest tests passed.
- 44 Playwright tests passed.
- 1 Playwright `fixme` remains for ICE failure simulation.
- `npm run demo` passes and exports JSON/CSV metrics.
- Latest full-run metrics: 30 gossip runs, p50 7ms, p95 9ms, max 12ms, 90% all-node receipt in the latest sample, 98.02% cache/P2P hit rate.
- Phase 7/8 automated validation: 178 Vitest tests passed, full `npm test` passed with 56 Playwright tests and 1 known skip, `npm run test:beta-next` passed with 7 Chromium tests, `npm run validate:external` passed with 5 Phase 7 tests, and `metrics:export` exports Phase 7 JSON/CSV.
- Phase 7 report: 3 pass, 1 partial, 0 fail, 6 not measured. LAN/WAN/TURN/background/mobile/geography remain manual external evidence, but the Next beta flow now captures background-tab lifecycle and mobile-oriented browser/device hints automatically when testers submit evidence.
- Backend security posture is tracked internally; public releases avoid exposing deployment-specific database migration details.

## Commands

```bash
npm run typecheck
npm run build
npm run beta:next:build
npm run test:unit
npm run test:beta-next
npm run verify:deployed-p2p
npm test
npm run demo
npm run validate:external
npm run stress:external
npm run beta:server
npm run beta:stack
npm run beta:export-ledger
npm run metrics:export
```

## Tooling Security

Do not run the original `gsd-build/get-shit-done` toolchain or `get-shit-done-cc` npm package. The local original GSD runtime was quarantined on 2026-05-23 after a supply-chain warning. If GSD tooling is needed again, use the maintained fork only after package metadata verification:

```bash
npx @opengsd/get-shit-done-redux@1.0.0 --codex --global
```

Use `@latest` only when intentionally accepting the newest redux release.

## Key Artifacts

- `NODEX_RESEARCH_RIGOR_STANDARD.md` — research rigor standard for paper-track development, evaluation, claims, collaboration, and real P2P evidence.
- `Nodex_Technical_Report.md` — main research report.
- `Nodex_Phase3_Complete_Technical_Report.md` — gossip/P2P/cache/encryption phase report.
- `Nodex_Phase4_Complete_Technical_Report.md` — volatility heuristic phase report.
- `Nodex_Phase5_Complete_Technical_Report.md` — 10-node metrics harness report.
- `Nodex_Phase6_Complete_Technical_Report.md` — integration hardening/demo report.
- `Nodex_Phase7_External_Validation_Report.md` — external-validity execution report.
- `Nodex_v1_3_Interphase_Closeout_Report.md` — 2026-06-17 interphase execution report for hosted smoke recovery, concurrent discovery hardening, and v1.4 planning.
- `Nodex_Multi_Machine_Test_Plan.md` — physical LAN/WAN/TURN/geographic validation plan.
- `research/` — formalization, benchmark, connectivity, consistency, and state-of-the-art research notes curated for public review.

Internal planning logs, private beta ledgers, person-specific test runbooks, meeting transcripts, and raw operational artifacts are intentionally excluded from the public repository.

## Architecture

- `src/sw/sw.ts` — Service Worker fetch routing, freshness, decrypt, P2P bridge, demo hooks.
- `src/p2p/p2p-manager.ts` — page-side WebRTC connection manager.
- `src/gossip/gossip-engine.ts` — custom epidemic gossip engine.
- `src/server/mock-api.ts` — encrypted mock origin and gossip seed endpoint.
- `src/server/signaling-server.ts` — Hono WebSocket matchmaker with room-scoped peer registries.
- `src/server/beta-coordinator.ts` — separate Vercel/Hono beta API control plane for token auth, personalized tester invites, sessions, evidence, logs, token management, Blob-backed storage, and backend request simulations.
- `api/signal/[...path].ts` — Vercel-compatible HTTP signaling fallback for deployed WebRTC handshakes and room-scoped gossip seeds.
- `src/dashboard/dashboard.ts` — metrics dashboard and SW registration.
- `apps/beta-suite/` — Next.js tester/admin beta suite. The `/run` page embeds the real `/metrics.html` protocol runtime rather than a simulated checklist.
- `tests/phase-05.spec.ts` and `tests/phase-06.spec.ts` — 10-node validation/demo suites.
- `scripts/verify-deployed-p2p.ts` — remote production smoke that verifies hosted WebRTC edge formation and a real `peer-fetch`.

## Limits

The PoC validates the local foreground loopback architecture. Hosted beta has produced a production-deployed sequential same-machine browser isolation pass, but the latest diagnostic rerun exposed a hosted mesh timeout against the still-deployed runtime, so the hosted smoke is not a stable beta gate yet. The 2026-06-17 interphase added poll-based peer discovery repair for concurrent/empty joins; this must be deployed and rerun before broad beta. Phase 7 measures local external-validity proxies such as ICE candidate telemetry, churn/rejoin, room isolation, storage pressure hooks, multi-tab identity/failover, and force-relay configuration plumbing. Two computers in the same city are enough for LAN and same-metro NAT tests, but not for geographic long-range / GOSP-06. Real LAN/WAN/TURN/background/mobile/geographic behavior remains unproven until the manual protocol is run.

## Beta Testing

Use the root app `/` with `npm run beta:stack` locally, or the hosted Next beta suite at `https://nodex-beta.vercel.app/`, for controlled internal/debug runs while topology evidence remains scoped. Do not invite broad external beta contributors until the manual topology checklist and concurrent join hardening pass. Hosted backend is `https://nodex-beta-api.vercel.app/api/beta/*`. The technical metrics dashboard remains available at `/metrics.html`; in production, the beta `/run` route loads that real runtime in an iframe with `nodexSignalingUrl=https://nodex-beta-api.vercel.app/api/signal`. The Next beta `/run` route persists protocol telemetry plus Page Visibility/lifecycle events and user-agent/device hints, and `/evidence` submits them under same-machine-isolation, background-tab, mobile-browser, LAN, WAN/NAT, TURN, or geographic topology labels. The beta coordinator stores local participant/evidence/run/simulation/log JSONL under `beta-data/` during local dev and uses Vercel Blob private storage in production. The ledger is for attribution and attorney review; it is not a legal inventorship determination.

Phase 11 added a dedicated Next.js app under `apps/beta-suite`, keeping the research PoC intact while giving testers/admins real routes, cleaner role separation, and a more polished guided-test workflow. Phase 12 then added room-scoped live room rigor and the 2026-05-27 deployed real-protocol validation path. Internal phase-planning artifacts are not part of the public repository.

Local Next beta suite:

```powershell
npm run beta:next:dev
npm run beta:next:build
npm run test:beta-next
```

Use `NEXT_PUBLIC_NODEX_BETA_API_URL` for the frontend API target. Never expose Supabase service-role/secret keys or beta admin tokens through `NEXT_PUBLIC_*`.
