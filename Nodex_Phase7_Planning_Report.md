# Nodex Phase 7 Planning Report

**Phase:** 07 - External Validity Validation  
**Date:** 2026-05-23  
**Status:** Planning complete, implementation not started  
**Mode:** Autonomous GSD-redux planning

## Executive Summary

Phase 7 should test the hardest remaining question in Nodex: not whether the local PoC works, but whether its core value survives real browser and network conditions.

The completed Phase 6 result is strong for loopback: 30 convergence runs, p50 2ms, p95 6ms, 93.33% all-node receipt, and 99.01% cache/P2P hit rate. That is enough to support a local proof of concept. It is not enough to claim real NAT/TURN, background tab, mobile, or geographic viability.

Phase 7 is therefore planned as an external-validity phase. It adds only the features needed to measure real-world behavior: configurable external origins, STUN/TURN injection, ICE candidate telemetry, churn recovery, multi-tab coordination, storage-pressure tests, and a claim-gated external validation report.

## Planned Deliverables

| Deliverable | Purpose |
|-------------|---------|
| `07-RESEARCH.md` | Source-backed research on WebRTC, Service Worker lifecycle, storage quota, and Playwright limits |
| `07-SPEC.md` | Falsifiable Phase 7 requirements and acceptance criteria |
| `07-CONTEXT.md` | Implementation context and locked decisions |
| `07-01-PLAN.md` | External network config and ICE telemetry |
| `07-02-PLAN.md` | External validity harness: churn, multi-tab, storage, manual protocol |
| `07-03-PLAN.md` | External validation report and claim gates |
| `07-VALIDATION.md` | Automated and manual verification gates |
| `07-PLAN-REVIEW.md` | Planning review and execution recommendation |

## Core Requirements Added

- EXT-01: non-localhost app/API/signaling configuration.
- EXT-02: STUN/TURN ICE config injection with no committed secrets.
- EXT-03: selected candidate type and WebRTC stats telemetry.
- EXT-04: report categories for loopback, LAN, WAN/NAT, TURN, mobile, background, and storage.
- EXT-05: churn/rejoin recovery measurement.
- EXT-06: one active P2P identity per browser profile/origin via multi-tab coordination.
- EXT-07: storage pressure and quota failure-path validation.
- EXT-08: conservative background/visibility measurement.
- EXT-09: GOSP-06 remains pending until measured external/geographic evidence exists.

## Expected Result After Implementation

After executing Phase 7, Nodex should be able to produce a report that says, with discipline:

- "Loopback works" with existing Phase 5/6 evidence.
- "LAN works" only if measured on multiple physical devices.
- "WAN/NAT works" only if ICE telemetry proves it.
- "TURN relay works" only if selected candidate type records `relay`.
- "Background/mobile behavior" only if directly measured.
- "Geographic long-range" only if real geography or region evidence exists.

That is exactly the standard needed for serious academic/commercial positioning: not louder claims, cleaner evidence.

## Execution Order

1. Externalize config and add ICE telemetry.
2. Add local automated tests for churn, multi-tab, storage, and telemetry export.
3. Add manual external protocol and claim-gated reporting.

Phase 7 should not start with the Go/Rust signaling rewrite. The rewrite will matter later, but the immediate research risk is external validity, not server language.

