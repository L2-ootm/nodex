# Handoff (2026-11-14)

Branch `codex/nodex-defensible`, pushed. Another agent can continue from this file and `research/friend-test/DEPLOY-AND-TEST-PLAN.md`.

## Where things stand

| Area | State | Evidence |
|---|---|---|
| Protocol (v3 freshness, detached proofs, peer proof exchange) | Implemented, unit and two-browser tested | 365 vitest tests; `tests/beta-real.spec.ts` 3/3 |
| Claim | Narrowed to H1 (no read older than 6 s, no rollback). Cost claim H2 reported failed against a compressing CDN | `research/NODEX_CLAIM_AND_PREREGISTRATION.md`, `research/friend-test/compress-audit-synthetic.txt` |
| Sign-in and guide | Masked token, tab-only by default, per-IP throttle (10 failures, 10 min, per instance), security headers, public `/guide` with preflight | `tests/beta-next.spec.ts` 10 pass; live check below |
| Production | Deployed: UI `https://nodex-beta.vercel.app`, API `https://nodex-beta-api.vercel.app`, commit `3007d6f` | `npm run verify:deployed-p2p` passes (peer-fetch observed) |
| Database | Supabase project `L2 TESTS` restored, migrations applied (8 repo files + `20261113000100_beta_schema_drift.sql`) | SQL editor checks |
| Rehearsal against production | 20/20 checks, plus the throttle check | `research/friend-test/rehearse-deployed.mjs` |
| Custom domains | `nodex.l2systems.com.br` and `nodex-api.l2systems.com.br` attached in Vercel, CNAMEs added in Cloudflare, resolve. TLS certificate not issued after about 15 minutes | Not switched; see "Open" |
| Real-network test with a friend | Not done | Steps in `/guide` |

## How production is deployed (no git integration, Hobby plan, 12-function limit)

Deploy from a git clone of the branch, always with `-e NODEX_DEPLOY_COMMIT=<sha> --build-env NODEX_DEPLOY_COMMIT=<sha>`.
- API project `nodex-beta-api` (`prj_R9h0wq67JfUdsf4fKsw4Ts82U7mt`): replace `vercel.json` in the clone with `{"framework":null,"buildCommand":"npm run build","outputDirectory":"dist","rewrites":[one rewrite per catch-all: /api/beta, /api/signal, /api/write, /api/invalidate -> /api/<name>/[...path]]}`.
- UI project `nodex-beta`: delete `api/` in the clone, keep the repo `vercel.json` (Next build). With `api/` present the UI answers `/api/*` without secrets (503).
- Details and reasons: "Update 2026-11-13 (later)" in the plan file.

## Credentials (nothing secret is in git)

- `.env.keys.local` (ignored, repo root) holds the admin token, the friend's tester token (`NODEX_FRIEND_TESTER_TOKEN`), publisher key, session key, signaling seed token, tenant id, epoch `authority-1`, and the Supabase secret key.
- The same values are set as production variables on `nodex-beta-api`. The `nodex-beta` UI project holds no tokens.
- TURN is the public Open Relay service with static credentials (`NODEX_ALLOW_STATIC_TURN=true`); fine for two people, not for more.

## Open items, in order

1. Custom domains: have the owner open Settings, Domains on both Vercel projects and fix whatever blocks the certificate (the CLI login cannot inspect or issue certificates for them). Then switch origins: `NODEX_BETA_APP_ORIGIN`, `NODEX_BETA_ALLOWED_ORIGINS` (may list both names), `NODEX_BETA_SIGNALING_URL` and `NODEX_BETA_SIGNALING_HTTP_URL` on the API project, `NEXT_PUBLIC_NODEX_BETA_API_URL` on the UI project; redeploy both; rerun `rehearse-deployed.mjs --app ... --api ...`.
2. Run the test with the friend: home to home, then the friend on a phone hotspot. Pre-registered thresholds in `research/friend-test/prereg-friend.json`; record results with `analyze.mjs`, failures included.
3. Revoke the friend's token afterwards, and the two older tester tokens (`Natanny`, `Francisco`) if they should not work.
4. Restore the Supabase free project just before the test if it paused again (pauses after about a week of inactivity).

## Known gaps

- Nothing yet measured over two real networks; the deployed peer check ran two browsers on one machine.
- The Run page was not driven end to end in two real browsers on the deployed UI (its API sequence and the peer path were checked separately).
- No script-src policy (Next inline scripts need a nonce pipeline); throttling is per serverless instance; no multi-factor.
- A never-written product returns 503 "Sequence authority unavailable" instead of 404.
- `verify-deployed-p2p.ts` still prints its own 403 on a manual signaling poll (it omits the node grant header); harmless, stale diagnostic.
- Root Playwright suite (57 tests) not re-run after the last changes. No repeatable deploy script. Peer-versus-origin proof provenance header not implemented.
- Simulator results are hypothesis-grade; the original H3a fails at 30 seeds and is reported, not re-tuned.
- The rehearsal left rows named "rehearsal" in the production ledger (two runs, one evidence row).

## Not mine, left untouched

`.freebuff/`, `CRITICAL.md`, `smoke-output-run1.txt` (untracked).
