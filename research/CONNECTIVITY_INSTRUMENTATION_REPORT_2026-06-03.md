# Connectivity Instrumentation Report — 2026-06-03

## What existed before this session

- `candidateTypeFromPair(localType, remoteType): CandidatePathType` — classifies `host`, `srflx`, `relay`, `unknown`. Correct behavior verified by existing tests.
- `extractPeerTelemetryFromStats(input): PeerTelemetrySample` — extracts selected candidate pair from `RTCStatsReport`, derives candidate types, RTT, bytes sent/received, ICE/connection/DC states, topology label.
- `collectPeerTelemetry()` — samples all live connections via `getStats()`, accumulates `telemetrySamples[]`.

## What changed this session

### `src/shared/types.ts`
Added three optional fields to `PeerTelemetrySample`:
- `ice_gather_duration_ms?: number` — duration from `icegatheringstate = 'gathering'` to `'complete'` in ms.
- `dc_open_latency_ms?: number` — duration from DataChannel object creation to first `'open'` event in ms.
- `signaling_success?: boolean` — true when at least one DataChannel has opened.

### `src/p2p/p2p-manager.ts`
Added to `PeerConnection` state model:
- `iceGatherStartAt?: number` — epoch ms when ICE gathering begins.
- `iceGatherEndAt?: number` — epoch ms when ICE gathering completes.
- `dcCreatedAt?: number` — epoch ms when DataChannels were created (set at connection creation).
- `dcOpenAt?: number` — epoch ms when first DataChannel `open` event fires.

Added `icegatheringstatechange` listener in `connectToPeer()`:
```ts
pc.addEventListener('icegatheringstatechange', () => {
  if (pc.iceGatheringState === 'gathering' && conn.iceGatherStartAt === undefined) {
    conn.iceGatherStartAt = Date.now()
  } else if (pc.iceGatheringState === 'complete' && conn.iceGatherStartAt !== undefined && ...) {
    conn.iceGatherEndAt = Date.now()
  }
})
```

Updated `gossip.addEventListener('open')` and `cacheFetch.addEventListener('open')` to record `dcOpenAt` on first open.

Updated `samplePeerTelemetry()` to compute and pass:
- `iceGatherDurationMs = iceGatherEndAt - iceGatherStartAt`
- `dcOpenLatencyMs = dcOpenAt - dcCreatedAt`
- `signalingSuccess = dcOpenAt !== undefined`

Updated `extractPeerTelemetryFromStats()` to include all three in the returned `PeerTelemetrySample`.

---

## Telemetry fields now captured per peer edge

| Field | Type | Description | Status |
|---|---|---|---|
| `selected_candidate_type` | `host/srflx/relay/unknown` | ICE path classification | **Measured** |
| `local_candidate_type` | same | Local ICE candidate type | **Measured** |
| `remote_candidate_type` | same | Remote ICE candidate type | **Measured** |
| `ice_connection_state` | string | ICE state at sample time | **Measured** |
| `connection_state` | string | RTCPeerConnection state | **Measured** |
| `data_channel_state` | string | DataChannel readyState | **Measured** |
| `current_round_trip_time_ms` | number | RTT from RTCP stats | **Measured** |
| `bytes_sent` | number | Cumulative bytes sent | **Measured** |
| `bytes_received` | number | Cumulative bytes received | **Measured** |
| `ice_gather_duration_ms` | number | ICE gathering wall-clock cost | **Measured (new)** |
| `dc_open_latency_ms` | number | DataChannel open wall-clock latency | **Measured (new)** |
| `signaling_success` | boolean | Whether any DC opened | **Measured (new)** |
| TURN-specific relay cost | — | Bytes via relay vs direct | **Not yet measured** |
| ICE candidate count | — | How many candidates were gathered | **Not measured** |
| NAT class classification | — | Symmetric / full-cone / etc. | **Not measured** |

---

## What claim this supports

**Allowed now:**
> Nodex captures per-edge telemetry including ICE path classification (host/srflx/relay/unknown), RTT, bytes, DataChannel latency, ICE gather duration, and signaling success flag. This provides the instrumentation baseline for measuring direct-vs-relay distribution once real cross-network test runs are executed.

**Still hypothesis / not yet measured:**
> Direct-vs-relay distribution at scale is NOT measured. The instrumentation exists but no real cross-network test run has been executed. Claims about Nodex direct P2P success rate are design-goal until a test across ≥2 distinct network classes produces relay/srflx/host counts.
>
> The relay cost advantage calculation (does Nodex's economics survive when TURN dominates?) requires computing bytes-via-relay vs bytes-via-direct, which is not yet automated.

---

## What remains for Phase 21

| Item | Status |
|---|---|
| Test across ≥2 real network classes (LAN + separate residential) | Blocked — requires physical setup |
| Aggregate direct-vs-relay distribution from `telemetrySamples[]` | Needs harness/report script |
| Compute relay cost ratio (TURN bytes / total bytes) | Design-goal |
| Add ICE candidate count to telemetry | Deferred |
| Sequence diagram of SDP/ICE exchange | Design-goal (WEBRTC_CONNECTIVITY_MODEL.md) |

---

## Evidence produced

- `npm run typecheck` passed.
- `npx vitest run src/p2p/p2p-manager.test.ts` — tests pass including `candidateTypeFromPair` and `extractPeerTelemetryFromStats` coverage.
- `npx vitest run` (full suite) — 155 tests, 0 failures.

---

## Next smallest safe step

Write a `scripts/aggregate-telemetry.ts` helper that reads `test-results/*.json` containing `PeerTelemetrySample[]`, counts direct/srflx/relay/unknown, and writes a `connectivity-distribution.md` summary. Run after any real multi-machine test to produce the first Nodex-specific distribution table.
