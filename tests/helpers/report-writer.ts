import * as fs from 'fs/promises'
import * as path from 'path'
import type { PeerTelemetrySample as SharedPeerTelemetrySample } from '../../src/shared/types'

export type PeerTelemetrySample = SharedPeerTelemetrySample

export interface SourceLatencyStats {
  p50: number
  p95: number
  p99: number
  count: number
}

export interface Phase05Report {
  timestamp: string
  convergence: {
    runs: number
    p50_ms: number
    p95_ms: number
    max_ms: number
    all_nodes_received_pct: number
    avg_hop_count: number
    dedup_verified: boolean
  }
  cache_hit_rate: {
    total_requests: number
    sw_cache: number
    peer_fetch: number
    server_fallback: number
    p2p_hit_rate_pct: number
  }
  latency_percentiles: {
    sw_cache: SourceLatencyStats
    peer_fetch: SourceLatencyStats
    server_fallback: SourceLatencyStats
  }
  cdp_fallback?: boolean
}

export type EvidenceStatus = 'pass' | 'partial' | 'fail' | 'not_measured'

export interface ExternalEvidenceEntry {
  status: EvidenceStatus
  notes: string
  measured_at?: string
}

export interface ExternalEvidenceSummary {
  total_categories: number
  pass: number
  partial: number
  fail: number
  not_measured: number
}

export interface ExternalValidationReport {
  schema_version: 1
  phase: '07'
  timestamp: string
  topology_label: string
  summary: ExternalEvidenceSummary
  evidence: Record<string, ExternalEvidenceEntry>
  edge_telemetry: PeerTelemetrySample[]
}

export async function writeReport(report: Phase05Report, dir = 'test-results'): Promise<string> {
  const outputDir = resolveOutputDir(dir)
  const outputPath = path.join(outputDir, 'phase-05-metrics.json')

  await fs.mkdir(outputDir, { recursive: true })
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2))

  return outputPath
}

function resolveOutputDir(dir: string): string {
  if (path.isAbsolute(dir) || dir.split(/[\\/]/).includes('..')) {
    throw new Error('metrics writers only accept project-relative output directories')
  }

  return path.join(process.cwd(), dir)
}

function csvEscape(value: string | number | boolean): string {
  const str = String(value)
  if (!/[",\n]/.test(str)) return str
  return `"${str.replace(/"/g, '""')}"`
}

function csvValue(value: string | number | boolean | undefined): string {
  return csvEscape(value ?? '')
}

export function reportToCsv(report: Phase05Report): string {
  const rows: Array<[string, string, string | number | boolean]> = [
    ['metadata', 'timestamp', report.timestamp],
    ['convergence', 'runs', report.convergence.runs],
    ['convergence', 'p50_ms', report.convergence.p50_ms],
    ['convergence', 'p95_ms', report.convergence.p95_ms],
    ['convergence', 'max_ms', report.convergence.max_ms],
    ['convergence', 'all_nodes_received_pct', report.convergence.all_nodes_received_pct],
    ['convergence', 'avg_hop_count', report.convergence.avg_hop_count],
    ['convergence', 'dedup_verified', report.convergence.dedup_verified],
    ['cache_hit_rate', 'total_requests', report.cache_hit_rate.total_requests],
    ['cache_hit_rate', 'sw_cache', report.cache_hit_rate.sw_cache],
    ['cache_hit_rate', 'peer_fetch', report.cache_hit_rate.peer_fetch],
    ['cache_hit_rate', 'server_fallback', report.cache_hit_rate.server_fallback],
    ['cache_hit_rate', 'p2p_hit_rate_pct', report.cache_hit_rate.p2p_hit_rate_pct],
  ]

  for (const [source, stats] of Object.entries(report.latency_percentiles)) {
    rows.push([`latency:${source}`, 'p50', stats.p50])
    rows.push([`latency:${source}`, 'p95', stats.p95])
    rows.push([`latency:${source}`, 'p99', stats.p99])
    rows.push([`latency:${source}`, 'count', stats.count])
  }

  return [
    'section,metric,value',
    ...rows.map((row) => row.map(csvEscape).join(',')),
  ].join('\n') + '\n'
}

export async function writeAcademicExport(
  report: Phase05Report,
  dir = 'test-results',
  basename = 'nodex-metrics-summary'
): Promise<{ jsonPath: string; csvPath: string }> {
  if (!/^[A-Za-z0-9._-]+$/.test(basename)) {
    throw new Error('writeAcademicExport basename must be filesystem-safe')
  }

  const outputDir = resolveOutputDir(dir)
  const jsonPath = path.join(outputDir, `${basename}.json`)
  const csvPath = path.join(outputDir, `${basename}.csv`)

  await fs.mkdir(outputDir, { recursive: true })
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2))
  await fs.writeFile(csvPath, reportToCsv(report))

  return { jsonPath, csvPath }
}

export function summarizeExternalEvidence(
  evidence: Record<string, ExternalEvidenceEntry>
): ExternalEvidenceSummary {
  const summary: ExternalEvidenceSummary = {
    total_categories: Object.keys(evidence).length,
    pass: 0,
    partial: 0,
    fail: 0,
    not_measured: 0,
  }

  for (const entry of Object.values(evidence)) {
    summary[entry.status] += 1
  }

  return summary
}

export function buildExternalValidationReport(input: {
  timestamp: string
  topology_label: string
  evidence: Record<string, ExternalEvidenceEntry>
  edgeTelemetry: PeerTelemetrySample[]
}): ExternalValidationReport {
  return {
    schema_version: 1,
    phase: '07',
    timestamp: input.timestamp,
    topology_label: input.topology_label,
    summary: summarizeExternalEvidence(input.evidence),
    evidence: input.evidence,
    edge_telemetry: input.edgeTelemetry,
  }
}

export function externalValidationReportToCsv(report: ExternalValidationReport): string {
  const rows: Array<Array<string | number | boolean | undefined>> = [
    ['metadata', 'timestamp', report.timestamp],
    ['metadata', 'topology_label', report.topology_label],
    ['summary', 'total_categories', report.summary.total_categories],
    ['summary', 'pass', report.summary.pass],
    ['summary', 'partial', report.summary.partial],
    ['summary', 'fail', report.summary.fail],
    ['summary', 'not_measured', report.summary.not_measured],
  ]

  for (const [key, entry] of Object.entries(report.evidence)) {
    rows.push([`evidence:${key}`, 'status', entry.status])
    rows.push([`evidence:${key}`, 'notes', entry.notes])
    if (entry.measured_at) rows.push([`evidence:${key}`, 'measured_at', entry.measured_at])
  }

  report.edge_telemetry.forEach((sample, index) => {
    const prefix = `edge:${index}`
    rows.push([prefix, 'room_id', sample.room_id])
    rows.push([prefix, 'topology_label', sample.topology_label])
    rows.push([prefix, 'node_id', sample.node_id])
    rows.push([prefix, 'peer_id', sample.peer_id])
    rows.push([prefix, 'role', sample.role])
    rows.push([prefix, 'selected_candidate_type', sample.selected_candidate_type])
    rows.push([prefix, 'local_candidate_type', sample.local_candidate_type])
    rows.push([prefix, 'remote_candidate_type', sample.remote_candidate_type])
    rows.push([prefix, 'ice_connection_state', sample.ice_connection_state])
    rows.push([prefix, 'connection_state', sample.connection_state])
    rows.push([prefix, 'data_channel_state', sample.data_channel_state])
    rows.push([prefix, 'current_round_trip_time_ms', sample.current_round_trip_time_ms])
    rows.push([prefix, 'bytes_sent', sample.bytes_sent])
    rows.push([prefix, 'bytes_received', sample.bytes_received])
    rows.push([prefix, 'timestamp', sample.timestamp])
  })

  return [
    'section,metric,value',
    ...rows.map((row) => row.map(csvValue).join(',')),
  ].join('\n') + '\n'
}

export async function writeExternalValidationExport(
  report: ExternalValidationReport,
  dir = 'test-results',
  basename = 'phase-07-external-validation'
): Promise<{ jsonPath: string; csvPath: string }> {
  if (!/^[A-Za-z0-9._-]+$/.test(basename)) {
    throw new Error('writeExternalValidationExport basename must be filesystem-safe')
  }

  const outputDir = resolveOutputDir(dir)
  const jsonPath = path.join(outputDir, `${basename}.json`)
  const csvPath = path.join(outputDir, `${basename}.csv`)

  await fs.mkdir(outputDir, { recursive: true })
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2))
  await fs.writeFile(csvPath, externalValidationReportToCsv(report))

  return { jsonPath, csvPath }
}
