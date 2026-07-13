import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  assertEvidenceBundleManifest,
  assertMeasurementEvent,
  parseEvidenceBundleManifestJson,
  parseMeasurementEventJson,
} from './measurement-contracts.js'

const digest = 'a'.repeat(64)
const base = {
  schema_version: 1 as const,
  event_id: 'event-1',
  event_time_server_ms: 1_784_000_000_000,
  experiment_id: 'nodex-observe-1',
  arm: 'B3' as const,
  assignment_id: 'assignment-1',
  commit_sha: 'abcdef1234567',
  build_digest: digest,
  protocol_version: 'measurement-v1',
  config_digest: digest,
  sample_probability: 0.25,
  region_coarse: 'br-southeast',
}

const events = [
  {
    ...base, event_type: 'read_observed', conventional_path: 'cdn', http_status: 200,
    latency_ms: 24, response_bytes: 4096, object_class: 'bounded', size_bucket: '1-16kb',
    auth_scope_class: 'public', telemetry_complete: true,
  },
  {
    ...base, event_type: 'shadow_decision', arm: 'B4', shadow_mode: 'S1', eligible: true,
    would_choose: 'peer', actual_path: 'cdn', policy_version: 'policy-1',
    reason_codes: ['candidate_eligible'], decision_latency_ms: 2, mismatch_class: 'none',
  },
  {
    ...base, event_type: 'webrtc_probe', arm: 'P1', topology_label: 'wan-nat',
    probe_phase: 'completed', pair_role: 'initiator', attempt_number: 1,
    signaling_state: 'connected', ice_state: 'connected', datachannel_state: 'open',
    duration_ms: 80, useful_bytes: 16384, control_bytes: 1200, payload_digest_verified: true,
    selected_candidate_type: 'srflx', ip_family: 'ipv4',
  },
  {
    ...base, event_type: 'invalidation_observed', invalidation_id: 'inv-1',
    object_class: 'bounded', authoritative_epoch: 2, authoritative_counter: 9,
    publish_ms: 1_784_000_000_000, duplicate: false, reordered: false, outcome: 'applied',
  },
  {
    ...base, event_type: 'coverage', expected_assignments: 100, observed_assignments: 99,
    completed: 95, missing_by_stage: { client_missing: 1 },
    cells: [{ cell_id: 'br-chromium-desktop', expected: 100, observed: 99 }],
    exclusions: ['operator_cancelled'], contamination_rate: 0, join_success_rate: 0.99,
    ground_truth_coverage: 0.999, claim_status: 'partial',
  },
]

const bundle = {
  schema_version: 2,
  bundle_id: 'bundle-1',
  generated_at: '2026-07-13T18:00:00.000Z',
  experiment_id: 'nodex-observe-1',
  claim_status: 'partial',
  commit_sha: 'abcdef1234567',
  working_tree_dirty: false,
  build_digest: digest,
  protocol_version: 'measurement-v1',
  config_digest: digest,
  schema_digest: digest,
  query_digest: digest,
  redaction_version: 'redaction-v1',
  assignment_spec_path: 'assignment-spec.json',
  coverage_path: 'data/coverage.json',
  artifacts: [{ path: 'data/events-0001.jsonl', sha256: digest, bytes: 1024 }],
  source_bundle_refs: [],
  limitations: ['pilot thresholds are provisional'],
  operator_kind: 'automation',
}

describe('measurement event contracts', () => {
  it('accepts one valid event for each v1 discriminator', () => {
    for (const event of events) expect(() => assertMeasurementEvent(event)).not.toThrow()
  })

  it('fails closed on missing provenance, unknown fields and invalid sampling', () => {
    const valid = events[0]
    const { commit_sha: _, ...missingCommit } = valid
    expect(() => assertMeasurementEvent(missingCommit)).toThrow('commit_sha')
    expect(() => assertMeasurementEvent({ ...valid, surprise: true })).toThrow('unknown field')
    expect(() => assertMeasurementEvent({ ...valid, sample_probability: 0 })).toThrow('sample_probability')
  })

  it('rejects raw sensitive fields recursively', () => {
    const coverage = events[4]
    expect(() => assertMeasurementEvent({ ...coverage, missing_by_stage: { token: 1 } })).toThrow('sensitive/raw field')
  })

  it('names malformed JSON and preserves the event discriminator', () => {
    expect(() => parseMeasurementEventJson('{nope', 'bad-event.json')).toThrow('bad-event.json: malformed JSON')
    expect(parseMeasurementEventJson(JSON.stringify(events[1])).event_type).toBe('shadow_decision')
  })

  it('keeps the JSON Schema documents versioned and parseable', async () => {
    for (const path of [
      'schemas/measurement/v1/measurement-events.schema.json',
      'schemas/measurement/v1/evidence-bundle-manifest.schema.json',
    ]) {
      const schema = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema')
      expect(schema['$id']).toContain('/measurement/v1/')
    }
  })

  it('keeps golden valid and sensitive-field fixtures enforceable', async () => {
    const valid = await readFile('tests/fixtures/measurement/valid-read-event.json', 'utf8')
    const sensitive = await readFile('tests/fixtures/measurement/invalid-sensitive-event.json', 'utf8')
    expect(parseMeasurementEventJson(valid).event_type).toBe('read_observed')
    expect(() => parseMeasurementEventJson(sensitive)).toThrow('sensitive/raw field')
  })
})

describe('measurement evidence bundle v2', () => {
  it('accepts complete provenance and artifact hashes', () => {
    expect(() => assertEvidenceBundleManifest(bundle)).not.toThrow()
    expect(parseEvidenceBundleManifestJson(JSON.stringify(bundle)).bundle_id).toBe('bundle-1')
  })

  it('rejects unknown fields, malformed digests and empty artifacts', () => {
    expect(() => assertEvidenceBundleManifest({ ...bundle, extra: true })).toThrow('unknown field')
    expect(() => assertEvidenceBundleManifest({ ...bundle, query_digest: 'nope' })).toThrow('query_digest')
    expect(() => assertEvidenceBundleManifest({ ...bundle, artifacts: [] })).toThrow('at least one artifact')
  })

  it('keeps the golden bundle fixture valid', async () => {
    const raw = await readFile('tests/fixtures/measurement/valid-evidence-bundle.json', 'utf8')
    expect(parseEvidenceBundleManifestJson(raw).bundle_id).toBe('bundle-fixture-1')
  })
})
