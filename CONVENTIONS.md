# Nodex Conventions

## Scope

- Browser hot path stays browser-native: Service Worker, Cache API, IndexedDB, WebCrypto, WebRTC DataChannels.
- Node.js/Hono is PoC infrastructure only for mock origin and signaling.
- No Python in project code or workflow scripts.

## Testing

- Vitest owns `*.test.ts` unit tests.
- Playwright owns `*.spec.ts` browser/integration tests.
- Playwright collection is restricted through `playwright.config.ts` `testMatch: '**/*.spec.ts'`.
- Multi-node tests should use `tests/helpers/harness.ts` and unique signaling rooms.
- Phase 7 external-validity tests must label evidence classes explicitly; local automation cannot stand in for LAN/WAN/mobile/geographic evidence.

## Cache And Freshness

- Cache keys are URL pathnames, not full URLs.
- Origin and peer payloads remain ciphertext in Cache Storage.
- Service Worker decrypts only when serving page code.
- Freshness uses server-issued monotonic sequence numbers, not wall-clock comparisons.

## P2P

- Raw `RTCPeerConnection`; no wrapper libraries.
- Two DataChannels per peer:
  - `gossip`: unordered/unreliable.
  - `cache-fetch`: ordered/reliable.
- The signaling server relays handshake messages only.
- Phase 7 WebRTC metrics should record selected candidate type as `host`, `srflx`, `relay`, or `unknown` whenever browser stats allow it.

## Documentation

- `.planning/PROJECT.md`, `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md`, and `.planning/STATE.md` are the project planning source of truth.
- Root reports are human-facing summaries.
- `test-results/phase-05-metrics.json` is the source metrics artifact for academic export.
- Phase 7 reports must distinguish `pass`, `partial`, `fail`, and `not_measured` rather than implying external evidence that was not collected.
- Beta evidence submissions should preserve lifecycle/device context when available: `lifecycleSignals` for Page Visibility/browser lifecycle events and `deviceHints` for user-agent, mobile, touch, viewport, platform, and connection hints.

## Research Rigor

- `NODEX_RESEARCH_RIGOR_STANDARD.md` is mandatory for paper-track work.
- Treat every architecture decision, experiment, report, and professor-facing artifact as if it may become part of a top-tier systems submission.
- Label claims as `proven`, `measured`, `partially validated`, `hypothesis`, `design goal`, or `not claimed`.
- Do not promote local-loopback, same-machine, or hosted smoke results into LAN, WAN, mobile, TURN, or geographic claims.
- Every experiment intended for research use must preserve command, commit, environment, topology, raw output path, summary output path, and the specific claim it supports.
- Red gates and failed tests must be documented as research evidence, not hidden.

## Tooling Security

- Do not run the original `gsd-build/get-shit-done` repository or `get-shit-done-cc` npm package.
- Use only the maintained `open-gsd/get-shit-done-redux` fork for future GSD workflows, after verifying npm metadata.
- Prefer the verified pinned version `@opengsd/get-shit-done-redux@1.0.0`; use `@latest` only intentionally.
- If trusted GSD tooling is unavailable, update `.planning/` manually and record the security bypass.
