import * as fs from 'fs/promises'
import { describe, expect, it } from 'vitest'
import {
  buildExternalValidationReport,
  externalValidationReportToCsv,
  reportToCsv,
  summarizeExternalEvidence,
  writeAcademicExport,
  type Phase05Report,
} from './report-writer'

function makeReport(): Phase05Report {
  return {
    timestamp: '2026-05-23T20:45:18.608Z',
    convergence: {
      runs: 30,
      p50_ms: 2,
      p95_ms: 5,
      max_ms: 11,
      all_nodes_received_pct: 1,
      avg_hop_count: 13.33,
      dedup_verified: true,
    },
    cache_hit_rate: {
      total_requests: 101,
      sw_cache: 91,
      peer_fetch: 9,
      server_fallback: 1,
      p2p_hit_rate_pct: 99.01,
    },
    latency_percentiles: {
      sw_cache: { p50: 1.1, p95: 1.4, p99: 1.5, count: 91 },
      peer_fetch: { p50: 4.9, p95: 6.5, p99: 6.5, count: 9 },
      server_fallback: { p50: 11.1, p95: 11.1, p99: 11.1, count: 1 },
    },
  }
}

describe('report writer academic export', () => {
  it('flattens Phase 5 metrics into stable CSV rows', () => {
    const csv = reportToCsv(makeReport())

    expect(csv).toContain('section,metric,value')
    expect(csv).toContain('convergence,all_nodes_received_pct,1')
    expect(csv).toContain('cache_hit_rate,p2p_hit_rate_pct,99.01')
    expect(csv).toContain('latency:peer_fetch,p95,6.5')
  })

  it('writes paired JSON and CSV artifacts under a project-relative directory', async () => {
    const { jsonPath, csvPath } = await writeAcademicExport(
      makeReport(),
      'test-results/unit-report-writer',
      'metrics-fixture'
    )

    const [json, csv] = await Promise.all([
      fs.readFile(jsonPath, 'utf8'),
      fs.readFile(csvPath, 'utf8'),
    ])

    expect(JSON.parse(json).convergence.runs).toBe(30)
    expect(csv).toContain('metadata,timestamp,2026-05-23T20:45:18.608Z')
  })

  it('rejects unsafe output directories and basenames', async () => {
    await expect(writeAcademicExport(makeReport(), '../outside', 'metrics')).rejects.toThrow(
      'project-relative'
    )
    await expect(writeAcademicExport(makeReport(), 'test-results', '../metrics')).rejects.toThrow(
      'filesystem-safe'
    )
  })

  it('builds a claim-gated Phase 7 external validation report', () => {
    const report = buildExternalValidationReport({
      timestamp: '2026-05-24T00:00:00.000Z',
      topology_label: 'loopback',
      evidence: {
        loopback: { status: 'pass', notes: 'Automated Chromium loopback telemetry collected' },
        lan_multi_machine: { status: 'not_measured', notes: 'Requires manual device run' },
        turn_relay: { status: 'partial', notes: 'Config supported; relay candidate not observed' },
      },
      edgeTelemetry: [
        {
          room_id: 'room-a',
          node_id: 'node-a',
          peer_id: 'node-b',
          role: 'local',
          selected_candidate_type: 'host',
          local_candidate_type: 'host',
          remote_candidate_type: 'host',
          ice_connection_state: 'connected',
          connection_state: 'connected',
          data_channel_state: 'open',
          timestamp: 1779550000000,
        },
      ],
    })

    expect(report.summary.total_categories).toBe(3)
    expect(report.summary.pass).toBe(1)
    expect(report.summary.partial).toBe(1)
    expect(report.summary.not_measured).toBe(1)
    expect(report.evidence.lan_multi_machine.status).toBe('not_measured')
  })

  it('flattens Phase 7 external validation into stable CSV rows', () => {
    const report = buildExternalValidationReport({
      timestamp: '2026-05-24T00:00:00.000Z',
      topology_label: 'loopback',
      evidence: {
        loopback: { status: 'pass', notes: 'Loopback telemetry collected' },
        geographic_long_range: { status: 'not_measured', notes: 'No geographic run yet' },
      },
      edgeTelemetry: [],
    })

    const summary = summarizeExternalEvidence(report.evidence)
    const csv = externalValidationReportToCsv(report)

    expect(summary).toEqual({ total_categories: 2, pass: 1, partial: 0, fail: 0, not_measured: 1 })
    expect(csv).toContain('section,metric,value')
    expect(csv).toContain('evidence:loopback,status,pass')
    expect(csv).toContain('evidence:geographic_long_range,status,not_measured')
  })
})
