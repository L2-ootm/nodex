# Nodex

Nodex is a browser-native P2P distributed dynamic cache proof of concept. Browser clients act as encrypted cache nodes through Service Workers and WebRTC DataChannels; invalidation propagates through server-sequenced gossip; a lightweight volatility heuristic controls cache/P2P eligibility.

## Status

v1.0 PoC milestone complete as of 2026-05-23. Phase 7 external-validity harness execution is complete as of 2026-05-24, with manual external-network UAT still pending.

Hosted beta validation update, 2026-05-27:

- `https://nodex-beta.vercel.app` now serves the Next.js beta suite plus the real Vite protocol runtime at `/metrics.html` and `/sw.js`.
- `https://nodex-beta-api.vercel.app` now serves the beta control plane and HTTP signaling fallback at `/api/signal/*`.
- Production smoke opened two isolated browser contexts against the hosted site, formed a WebRTC edge through deployed HTTP signaling, seeded `/api/products/1` on node A, and observed node B serve the same key with `peer-fetch: 1`.
- Latest production deployment IDs: web `dpl_A6ZJmtFwBDxyN1gMfAdA6nxfGfr6`; backend `dpl_HEbGrpaq9yyb5zr95oCctSENgwE2`.

Beta readiness forensics update, 2026-05-31:

- Do not start broad external beta yet. `docs/qa/nodex-forensics-beta-readiness-2026-05-31.md` found the current hosted deployed P2P smoke failing with `mesh connection timeout; counts=0,0`.
- The same forensics pass found `npm run validate:external` failing in EXT-05 at `POST /api/gossip-seed`.
- New v1.3 recovery milestone added as Phases 13-16: hosted P2P smoke recovery, churn/rejoin freshness recovery, tester UX/evidence reliability, and beta release candidate/evidence hygiene.

Final local-loopback validation:

- 96 Vitest tests passed.
- 44 Playwright tests passed.
- 1 Playwright `fixme` remains for ICE failure simulation.
- `npm run demo` passes and exports JSON/CSV metrics.
- Latest full-run metrics: 30 gossip runs, p50 7ms, p95 9ms, max 12ms, 90% all-node receipt in the latest sample, 98.02% cache/P2P hit rate.
- Phase 7/8 automated validation: 114 Vitest tests passed, 5 Phase 7 Playwright tests passed, 5 Phase 7 stress tests passed, beta web Playwright passed, stress repeat passed 15/15, full `npm test` passed with 55 Playwright tests and 1 known skip, and `metrics:export` exports Phase 7 JSON/CSV.
- Phase 7 report: 3 pass, 1 partial, 0 fail, 6 not measured. LAN/WAN/TURN/background/mobile/geography remain manual external evidence, but the Next beta flow now captures background-tab lifecycle and mobile-oriented browser/device hints automatically when testers submit evidence.
- Supabase security advisor is clean as of 2026-05-25 after hardening `public.beta_ledger` with `security_invoker` and least-privilege view grants.

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

- `NODEX_RESEARCH_RIGOR_STANDARD.md` — top-tier research rigor standard for paper-track development, evaluation, claims, collaboration, and real P2P evidence.
- `Nodex_Technical_Report.md` — main research report.
- `Nodex_Phase6_Complete_Technical_Report.md` — final phase report.
- `Nodex_Phase7_Planning_Report.md` — external-validity planning report.
- `Nodex_Phase7_External_Validation_Report.md` — Phase 7 execution report.
- `Nodex_Multi_Machine_Test_Plan.md` — physical LAN/WAN/TURN/geographic validation plan.
- `Nodex_Beta_Testing_Guide.md` — invite-token beta testing workflow.
- `Nodex_Arturo_Real_Test_Protocol_2026-06-01.md` — Davi + Arturo real two-device test matrix, URLs, evidence rules, and post-call reporting requirements.
- `Nodex_Deployed_Beta_P2P_Validation_Report.md` — 2026-05-27 hosted real-node P2P validation report.
- `BETA_CONTRIBUTOR_LEDGER.md` — contributor/evidence ledger handling notes.
- `test-results/phase-05-metrics.json` — source metrics from the latest full run.
- `test-results/nodex-metrics-summary.json` and `.csv` — academic export.
- `test-results/phase-07-external-validation.json` and `.csv` — Phase 7 claim-gated external-validity report.
- `.planning/ROADMAP.md`, `.planning/STATE.md`, `.planning/REQUIREMENTS.md` — planning project state.
- `.planning/SECURITY-GSD-MIGRATION-2026-05-23.md` — GSD supply-chain incident response and migration note.
- `.planning/phases/07-external-validity-validation/` — Phase 7 research, spec, plans, validation strategy, and plan review.
- `.planning/phases/11-next-beta-suite/11-PLAN.md` — planned Next.js migration for the beta tester/admin suite.

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

The PoC validates the local foreground loopback architecture, and the hosted beta previously validated a production-deployed same-machine browser isolation smoke. As of the 2026-05-31 forensics report, that hosted smoke must be restored before broad beta evidence collection resumes. Phase 7 measures local external-validity proxies such as ICE candidate telemetry, churn/rejoin, room isolation, storage pressure hooks, multi-tab identity/failover, and force-relay configuration plumbing, but EXT-05 is currently red and tracked in Phase 14. Two computers in the same city are enough for LAN and same-metro NAT tests, but not for geographic long-range / GOSP-06. Real LAN/WAN/TURN/background/mobile/geographic behavior remains unproven until the manual protocol is run.

## Beta Testing

Use the root app `/` with `npm run beta:stack` locally, or the hosted Next beta suite at `https://nodex-beta.vercel.app/`, for controlled internal/debug runs while Phases 13-16 are active. Do not invite broad external beta contributors until the greenlight checklist passes. Hosted backend is `https://nodex-beta-api.vercel.app/api/beta/*`. The technical metrics dashboard remains available at `/metrics.html`; in production, the beta `/run` route loads that real runtime in an iframe with `nodexSignalingUrl=https://nodex-beta-api.vercel.app/api/signal`. The Next beta `/run` route persists protocol telemetry plus Page Visibility/lifecycle events and user-agent/device hints, and `/evidence` submits them under background-tab, mobile-browser, LAN, WAN/NAT, or TURN topology labels. The beta coordinator stores local participant/evidence/run/simulation/log JSONL under `beta-data/` during local dev and uses Vercel Blob private storage in production. The ledger is for attribution and attorney review; it is not a legal inventorship determination.

Phase 11 added a dedicated Next.js app under `apps/beta-suite`, keeping the research PoC intact while giving testers/admins real routes, cleaner role separation, and a more polished guided-test workflow. Phase 12 then added room-scoped live room rigor and the 2026-05-27 deployed real-protocol validation path. Planning artifacts live in `.planning/phases/11-next-beta-suite/` and `.planning/phases/12-hybrid-live-room-ultradesign/`.

Local Next beta suite:

```powershell
npm run beta:next:dev
npm run beta:next:build
npm run test:beta-next
```

Use `NEXT_PUBLIC_NODEX_BETA_API_URL` for the frontend API target. Never expose Supabase service-role/secret keys or beta admin tokens through `NEXT_PUBLIC_*`.
