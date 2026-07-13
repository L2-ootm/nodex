# Nodex Beta Suite

Dedicated Next.js/React product surface for invited Nodex beta testers and admins.

## Local Commands

```powershell
npm run beta:next:dev
npm run beta:next:build
npm run beta:next:start
npm run test:beta-next
npm run verify:deployed-p2p
```

The app runs on `http://localhost:4174` during local development. The existing Vite research PoC continues to use `http://localhost:4173`.

## Environment

Frontend-safe variables only:

```powershell
NEXT_PUBLIC_NODEX_BETA_API_URL="https://nodex-beta-api.vercel.app"
```

Do not add Supabase service-role, Supabase secret, admin token, or beta token secrets to the Next frontend environment. All privileged behavior must go through the beta API.

## Routes

Tester:

- `/`
- `/setup`
- `/profile`
- `/room`
- `/run`
- `/evidence`
- `/receipt`

Admin:

- `/admin`
- `/admin/tokens`
- `/admin/runs`
- `/admin/monitor`
- `/admin/ledger`
- `/admin/audit`

## UX Notes

- Preserve the legacy beta branding when changing layouts: top-left Nodex logo, styled wordmark, compact beta pill, dark grid background, and the large standalone X emblem on the login screen.
- Tester pages should use short, non-technical copy. Keep one primary action per screen whenever possible.
- Tester profile fields are cached in the browser for convenience, but contribution notes are intentionally not cached because they may change per evidence submission.
- Tester identities are keyed by the full saved invite token in local browser storage, with legacy fallback for older cached profiles. Do not hardcode tester/admin names in UI logic.
- Testers may open only solo rooms directly. Shared rooms must be created by an admin/coordinator and selected from `/api/beta/rooms`.
- When testers select `Coordinator + tester` or `Group`, the shared room list must appear. If the backend returns no rooms, show `Nenhuma sala encontrada.` and do not imply that a shared test room exists.
- Admins can join a recent run as coordinator from `/admin/runs`; the displayed coordinator name is typed by the admin and persisted locally, not hardcoded.
- The live room posts `/api/beta/presence` with `roomId` and `participantId`; nodes are marked ready only when the backend returns a live heartbeat for that same room. Coordinator users are shown as ordinary consumer nodes, not as the backend/origin.
- The live room shows `Origin DB` as an external source rail: the first server/database GET seeds one consumer, then consumers distribute data across the mesh. The origin is not drawn as a direct connection to every node.
- Room joins emit `/api/beta/logs`, so room activity is saved automatically by the backend store/Supabase path for later analysis.
- Token management and admin monitoring routes must stay hidden from tester sessions.
- `/run` must execute the real protocol runtime. It embeds `/metrics.html`, waits for the Service Worker/P2P manager, fetches encrypted `/api/products/*`, seeds gossip through `/api/signal/gossip-seed`, and records SW/P2P/server path counts. Do not replace this with a cosmetic checklist.
- `/run` also records Page Visibility and browser lifecycle signals (`run-start`, `visibilitychange`, `pagehide`, `pageshow`, `freeze`, `resume`, `protocol-complete`) plus user-agent/device hints. `/evidence` attaches that bundle automatically, defaults solo runs to the `same-machine-isolation` topology, and exposes `background-tab` and `mobile-browser` as Phase 7 evidence categories for explicit tester selection.
- Submitted evidence can include `lifecycleSignals` and `deviceHints`; the beta API persists them in JSONL locally and in Supabase JSONB columns in production.

## Deployment Notes

Production aliases as of 2026-05-27:

- Web: `https://nodex-beta.vercel.app` (`dpl_A6ZJmtFwBDxyN1gMfAdA6nxfGfr6`)
- Backend: `https://nodex-beta-api.vercel.app` (`dpl_HEbGrpaq9yyb5zr95oCctSENgwE2`)

The backend also hosts HTTP signaling at `/api/signal/*`, used by `/run` and external test tabs through the `nodexSignalingUrl` query parameter.

Deploy this app as a preview before changing the `nodex-beta.vercel.app` alias. The current production alias should be moved only after:

- `npm run beta:next:build` passes;
- `npm run test:beta-next` passes;
- `npm run verify:deployed-p2p` passes against the target aliases after the latest runtime/API changes are deployed;
- preview smoke tests pass against `nodex-beta-api.vercel.app`;
- tester tokens cannot access admin routes;
- admin token creation/revoke works in preview.

Rollback is the previous Vercel deployment alias for `nodex-beta.vercel.app`.

`verify:deployed-p2p` fails closed unless the web runtime build commit and backend `X-Nodex-Commit` match the expected commit. It uses the current local Git `HEAD` by default; use `--expected-commit=<sha>` or `NODEX_DEPLOYED_EXPECTED_COMMIT` only when intentionally checking a different deployed commit.
