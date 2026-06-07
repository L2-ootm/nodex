# Nodex Phase 7 External Validation Report

**Date:** 2026-05-24  
**Status:** Automated validation complete; manual external evidence pending  
**Source artifact:** `test-results/phase-07-external-validation.json`

## Summary

Phase 7 implemented the external-validity harness for Nodex. The project can now configure non-localhost rooms, inject STUN/TURN ICE settings, force relay mode, collect WebRTC candidate-pair telemetry, test local churn/rejoin, prevent duplicate active P2P identities across tabs, record browser storage pressure estimates, stress local room isolation and leader failover, and export a claim-gated report. The Next beta tester flow now adds automatic background-tab and mobile-oriented evidence capture by persisting Page Visibility/browser lifecycle signals and user-agent/device hints with each submitted evidence record.

Latest automated evidence:

| Evidence class | Status |
|----------------|--------|
| Loopback | pass |
| Churn | pass |
| Multi-tab coordination | pass |
| Storage pressure | partial |
| LAN multi-machine | not_measured |
| WAN/NAT | not_measured |
| TURN relay | not_measured |
| Background tab | not_measured |
| Mobile browser | not_measured |
| Geographic long-range / GOSP-06 | not_measured |

## Telemetry Captured

The latest report includes real loopback WebRTC edge samples with:

- `selected_candidate_type: "host"`
- ICE state: `connected`
- connection state: `connected`
- DataChannel state: `open`
- RTT and byte counters from `RTCPeerConnection.getStats()`

Additional local stress validation:

- `tests/phase-07-stress.spec.ts` passed 5/5.
- Repeated stress run passed 15/15 with `--repeat-each=3`.
- Covered independent room isolation, multi-tab leader failover, repeated local writes/storage sampling, force-relay config observability, and repeated churn/rejoin telemetry.

## Claim Boundary

Phase 7 strengthens Nodex by making external validation measurable. It does not yet prove global deployment behavior.

Safe current claim:

> Nodex has a working local browser P2P dynamic-cache PoC and now includes the instrumentation needed to validate external network behavior.

Unsafe until manual evidence exists:

> Nodex works across real WAN/NAT, TURN relay, mobile browsers, background tabs, or geographic long-range topologies.

## Next Evidence To Collect

Use the public multi-machine test plan to collect LAN, WAN/NAT, TURN, background, mobile, and geographic evidence. For background and mobile categories, prefer the Next beta `/run` -> `/evidence` path because it attaches lifecycle and device-hint fields automatically.

Use `Nodex_Multi_Machine_Test_Plan.md` for the concrete two-machine setup. Two computers in the same city are valid for LAN and same-metro WAN/NAT evidence, but not for geographic long-range / GOSP-06.
