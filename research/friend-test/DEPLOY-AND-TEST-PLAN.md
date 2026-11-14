# Deployment and two-person test plan

Written 2026-11-13 from read-only inspection of the Vercel account and sibling projects. Nothing was deployed or changed in production.

## What exists today (verified)

| Item | Finding |
|---|---|
| Hosting | Vercel team `l2works2-gmailcoms-projects`. Nodex runs as two projects: `nodex-beta` (Next.js tester UI, `https://nodex-beta.vercel.app`, last production deploy 21 days ago) and `nodex-beta-api` (`https://nodex-beta-api.vercel.app`, 166 days ago). A third, `beta-suite`, is older (171 days) and probably legacy. |
| Domain pattern | Sibling projects use `*.vercel.app` for tools and a custom domain for client-facing work (`l2systems.com.br`, subdomain `criaturas.l2systems.com.br`). Nodex has no custom domain. Not needed for the test. |
| Cloudflare | Used by `L2-SECRETARY` and `Meselo` (Workers config in `wrangler.jsonc`). Nodex does not use it, and `wrangler whoami` showed no logged-in account on this machine. Not needed for the test. |
| TURN | `nodex-beta-api` has `NODEX_TURN_URLS`, `NODEX_TURN_USERNAME`, `NODEX_TURN_CREDENTIAL` set. Whether the current route accepts these names is unverified: `.env.example` documents `NODEX_TURN_SHARED_SECRET`. |
| Deployed code | Pre-dates the v3 freshness protocol (signed time, detached proofs, renewal, peer proof exchange). The deployed API will not serve the protocol this branch tests. |

## Blockers before a real test (verified by variable names only; values were not read)

`nodex-beta-api` production lacks the variables the v3 server requires in production mode, so `getPublisher()` would throw on the first read:
`NODEX_PUBLISHER_PRIVATE_JWK`, `NODEX_TENANT_ID` (must be a UUID), `NODEX_PUBLISHER_EPOCH` (explicit, not `development`), `NODEX_SESSION_KEY_HEX`, `NODEX_SEQUENCE_DRIVER=supabase`, `NODEX_SIGNALING_SEED_TOKEN`.

Also found:
- `nodex-beta` (the UI project) holds `NODEX_BETA_ADMIN_TOKENS` and `NODEX_BETA_TOKENS`. `apps/beta-suite/README.md` says the frontend must not hold these. Remove them from that project after confirming the UI does not read them.
- Supabase migrations in `supabase/migrations/` must be applied in order to the database the API points at. Whether they are current there is unknown.
- Vercel and Supabase plan tiers are unknown (not exposed by the CLI calls used). Check both dashboards for function duration, bandwidth and database limits before relying on a long run.

## Limits that matter for a two-person run

- Next front limiter (`apps/beta-suite/proxy.ts`, per process): signaling 1200/min, products 200/min, time 30/min, session key 20/min. One reader at 1 read/s uses 60/min of the products budget, so two people are far under it.
- API per-credential limits (`api/lib/rate-limit.ts`) are per serverless instance, not global.
- New in this change: failed sign-ins are throttled per client IP (10 failures, then 429 for 10 minutes), per instance. The pre-existing lockout is per token hash and does not slow a guesser who changes the token each time.
- Signaling is HTTP polling, so Vercel's lack of WebSocket support is not a constraint.

## Plan

Owner actions are marked (you); the rest I can do on request.

1. (you) Approve a production deploy. It creates secrets and changes the live API for anyone using the old beta; nothing here was done without that.
2. Generate keys: `npm run keys:generate` (writes an ignored `.env.keys.local`, never prints secrets). Import the values into `nodex-beta-api` as production secrets. Set tenant UUID, an explicit epoch, `NODEX_SEQUENCE_DRIVER=supabase`.
3. Apply `supabase/migrations/*.sql` in order. Confirm anonymous access is off.
4. Run `npm run config:production` locally against the production environment (structural check only).
5. Deploy the API project and the UI project from this branch together (`npm run beta:next:build` for the UI), then run `npm run verify:deployed-p2p` against the deployed URLs.
6. Mint two invitations in Admin, Tokens: one admin (you), one tester (friend). Send the friend's token privately.
7. Rehearse alone: two browser profiles on your machine, both signed in, a shared room, the in-app guide. Fix anything that fails before involving the friend.
8. Run with the friend by following the in-app guide at `/guide` (same steps as below). Run twice: home to home, then the friend on a phone hotspot.
9. Revoke the friend's token. Record results with `research/friend-test/analyze.mjs` and write them into the claim document, including failures.

## The test, in short

The page `/guide` (no sign-in needed) holds the step-by-step and a preflight (browser support, server reachability, signed clock, connection type). Two tools overlap and serve different purposes:
- Beta suite rooms (`/admin/runs`, `/room`, `/run`, `/evidence`): enrollment, shared room, presence, evidence receipt.
- `research/friend-test` harness (`STEER.md` section 7, thresholds in `prereg-friend.json`): the pre-registered measurement that can falsify the freshness bound and test whether peers connect. Freeze the thresholds before the first counted run.

Pass or fail is decided in advance: any read older than 6 s plus measured clock slack, or any version rollback, fails the freshness claim. Peer connection feasibility is judged separately and cannot support the cost claim, which the compression audit already failed.

## Security posture of the page after this change

- Invitation field hidden by default, with Show; no autofill or spellcheck.
- Invitation kept in the tab only unless "Remember me" is ticked (existing sessions that were remembered stay remembered).
- Failed sign-ins throttled per IP; the page explains a 429.
- Response headers: `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'`, `base-uri`, `object-src`, `form-action`, `Permissions-Policy`, HSTS. Same-origin framing is required because the run page embeds the protocol runtime in an iframe.
- Not done: no script-src policy (Next's inline bootstrap needs a nonce pipeline first); tokens are bearer secrets sent in a header, not passwords; throttling is per instance; no multi-factor.

## Update 2026-11-13: database state (verified in the Supabase dashboard and wrangler)

- Supabase project `L2 TESTS` (free org, Nano compute) was paused. It was restored and reports Healthy.
- Production `SUPABASE_URL` and `SUPABASE_SECRET_KEY` on `nodex-beta-api` are empty strings. They still have to be set (secret key from the dashboard, never printed or committed).
- Migrations through `20260714010633` were already applied. The five `20261002*` migrations were missing and are now applied. Check: 10 nodex/beta functions, 17 public tables, 0 without RLS, 13 MB. The migrations history table was not updated (applied via the SQL editor, not the CLI).
- Cloudflare D1 (wrangler logged in): 7 databases, about 2 MB total. D1 is not used by Nodex and a port is not planned: the server relies on Postgres functions for atomic sequence, snapshot, signaling, token and outbox work.

## Update 2026-11-13 (later): production deployment, as done

Hosting plan is Vercel Hobby: at most 12 serverless functions per deployment. Both projects are deployed from a local git clone of the branch (so Vercel records the checkout), always with `-e NODEX_DEPLOY_COMMIT=<sha> --build-env NODEX_DEPLOY_COMMIT=<sha>` because CLI deploys get no `VERCEL_GIT_COMMIT_SHA`.

- `nodex-beta-api` (API): the clone's `vercel.json` is replaced by `{"framework":null,"buildCommand":"npm run build","outputDirectory":"dist","rewrites":[...]}` with one rewrite per catch-all (`/api/beta/:path+` to `/api/beta/[...path]`, same for signal, write, invalidate). Without the rewrites nested paths such as `/api/beta/tokens/:id/revoke` return 404 on this layout.
- `nodex-beta` (UI): the clone has `api/` deleted so the Next rewrites forward `/api/*` to the API project. With `api/` present the UI project answered `/api/time` itself without the production secrets (503).
- Repo changes needed to deploy: `api/lib` renamed `api/_lib` and `.vercelignore` for api tests (23 functions became 10), three `.js` import extensions in `src/server` (ESM resolution failed at runtime: `FUNCTION_INVOCATION_FAILED` on signaling), commit fallbacks in `api/session-key.ts` and `vite.config.ts`.
- Production variables set on `nodex-beta-api` (secrets as sensitive): tenant id, epoch `authority-1`, publisher private key, session key, signaling seed token, admin token, Supabase URL and secret key, storage and sequence drivers, origins, signaling URLs, `NODEX_SKIP_API_REWRITES=1`, `NODEX_ALLOW_STATIC_TURN=true`. The credentials live only in the ignored `.env.keys.local` and in Vercel.
- Admin and tester token variables removed from the `nodex-beta` UI project.
- TURN: the existing static credentials point at the public Open Relay service (`openrelay.metered.ca`), shared and best effort, and static TURN credentials are visible to any signed-in tester. Acceptable for a two-person beta, not for anything larger. Set `NODEX_TURN_SHARED_SECRET` on a TURN server you control for a real product.
- Existing token rows in Supabase from earlier testers (two testers) are still active; revoke them in Admin, Tokens if they should not work.

### Verification result (`npm run verify:deployed-p2p`, target `https://nodex-beta.vercel.app/metrics.html`)

Passed: deployment identity (app and API at the same commit), authenticated session key, signed time, signed writes (v1 to v4 acknowledged in 400 to 520 ms), two real headless browsers formed a WebRTC mesh over the deployed signaling with TURN configured, seed read 200.
Failed at the last assertion: `connected mesh formed, but peer-fetch metric was not observed; metrics={"server-fallback":1}`. Node B read product 1 from the origin, not from node A. Not yet diagnosed: whether node A had cached the seed first, or whether the v3 peer path declined it. The mesh is real, the data path through it is not shown.
The script's own manual `/api/signal/poll` returns 403 because it does not send the node grant header; the application client does, so this is a stale diagnostic in the script, not a server fault. A never-written product also returns 503 "Sequence authority unavailable" instead of 404.

## Custom domains (attached in Vercel, DNS record still owner action)

`nodex.l2systems.com.br` is attached to `nodex-beta` and `nodex-api.l2systems.com.br` to `nodex-beta-api`. `l2systems.com.br` is on Cloudflare DNS and the wrangler login is zone read-only, so the records were not created. Owner action in Cloudflare DNS, same pattern as `criaturas`: two CNAME records, `nodex` and `nodex-api`, both to `cname.vercel-dns.com`, DNS only (grey cloud).

Switch-over, only after both names resolve and Vercel shows them valid: set `NODEX_BETA_APP_ORIGIN` and `NODEX_BETA_ALLOWED_ORIGINS` to the UI name and `NODEX_BETA_SIGNALING_URL` / `NODEX_BETA_SIGNALING_HTTP_URL` to `https://nodex-api.l2systems.com.br/api/signal` on the API project, set `NEXT_PUBLIC_NODEX_BETA_API_URL` on the UI project, redeploy both, rerun `rehearse-deployed.mjs --app ... --api ...`. Keep the `*.vercel.app` names working until then (allowed origins can list both, comma separated).

Status 2026-11-14: the two CNAME records (`nodex`, `nodex-api` to `cname.vercel-dns.com`, DNS only) were added in Cloudflare and resolve to Vercel IPs. HTTPS still fails the TLS handshake about 15 minutes later (no certificate yet), while `criaturas.l2systems.com.br` on the same target works. The CLI login cannot inspect or issue certificates for these names (`vercel domains inspect` and `vercel certs issue` return a permission error), so the state of the domains in Vercel (Settings, Domains on each project) has to be checked by the team owner. Nothing was switched: the app and API still use the `*.vercel.app` addresses, which keep working.
