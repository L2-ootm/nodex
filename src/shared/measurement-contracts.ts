export const MEASUREMENT_EVENT_TYPES = [
  'assignment_created',
  'read_observed',
  'shadow_decision',
  'webrtc_probe',
  'invalidation_observed',
  'coverage',
] as const

export const MEASUREMENT_ARMS = ['B0', 'B1', 'B2', 'B3', 'B4', 'P1', 'P2'] as const
export const MEASUREMENT_CLAIM_STATUSES = [
  'measured', 'partial', 'hypothesis', 'not_measured', 'inconclusive',
] as const

export type MeasurementEventType = typeof MEASUREMENT_EVENT_TYPES[number]
export type MeasurementArm = typeof MEASUREMENT_ARMS[number]
export type MeasurementClaimStatus = typeof MEASUREMENT_CLAIM_STATUSES[number]
type JsonRecord = Record<string, unknown>

export interface MeasurementEnvelopeV1 {
  schema_version: 1
  event_type: MeasurementEventType
  event_id: string
  event_time_server_ms: number
  experiment_id: string
  arm: MeasurementArm
  assignment_id: string
  commit_sha: string
  build_digest: string
  protocol_version: string
  config_digest: string
  sample_probability: number
  region_coarse: string
  run_id?: string
  request_id?: string
  session_id_ephemeral?: string
  tenant_hash_epoch?: string
  key_hash_epoch?: string
  consent_version?: string
  browser_engine_major?: string
  os_major?: string
  device_class?: string
  visibility_state?: string
  monotonic_offset_ms?: number
  clock_uncertainty_ms?: number
}

export interface AssignmentCreatedV1 extends MeasurementEnvelopeV1 {
  event_type: 'assignment_created'
  assignment_unit: 'session' | 'request' | 'probe_pair'
  registry_version: string
  cell_id: string
  population: string
  assignment_hash_version: string
  eligibility_state: 'eligible' | 'ineligible' | 'unknown'
  exclusion_reason?: string
}

export interface ReadObservedV1 extends MeasurementEnvelopeV1 {
  event_type: 'read_observed'
  conventional_path: 'origin' | 'cdn' | 'sw'
  http_status: number
  latency_ms: number
  response_bytes: number
  object_class: string
  size_bucket: string
  auth_scope_class: string
  telemetry_complete: boolean
  cdn_cache_status?: string
  cdn_age_ms?: number
  returned_epoch?: number
  returned_counter?: number
  authoritative_epoch?: number
  authoritative_counter?: number
  k_versions?: number
  t_ms?: number
  proof_age_ms?: number
  admission_result?: 'admitted' | 'rejected' | 'not_evaluated'
  admission_reason?: string
}

export interface ShadowDecisionV1 extends MeasurementEnvelopeV1 {
  event_type: 'shadow_decision'
  shadow_mode: 'S1' | 'S2' | 'S3'
  eligible: boolean
  would_choose: 'origin' | 'cdn' | 'sw' | 'peer' | 'none'
  actual_path: 'origin' | 'cdn' | 'sw'
  policy_version: string
  reason_codes: string[]
  decision_latency_ms: number
  mismatch_class: string
  candidate_epoch?: number
  candidate_counter?: number
  would_admit?: boolean
}

export interface WebRtcProbeV1 extends MeasurementEnvelopeV1 {
  event_type: 'webrtc_probe'
  topology_label: string
  probe_phase: string
  pair_role: 'initiator' | 'responder'
  attempt_number: number
  signaling_state: string
  ice_state: string
  datachannel_state: string
  duration_ms: number
  useful_bytes: number
  control_bytes: number
  payload_digest_verified: boolean
  selected_candidate_type?: 'host' | 'srflx' | 'relay' | 'unknown'
  relay_transport?: string
  ip_family?: 'ipv4' | 'ipv6' | 'nat64' | 'unknown'
  rtt_ms?: number
  failure_stage?: string
  failure_reason?: string
  turn_region?: string
  network_transition?: string
  lifecycle_state?: string
}

export interface InvalidationObservedV1 extends MeasurementEnvelopeV1 {
  event_type: 'invalidation_observed'
  invalidation_id: string
  object_class: string
  authoritative_epoch: number
  authoritative_counter: number
  publish_ms: number
  duplicate: boolean
  reordered: boolean
  outcome: string
  edge_receive_ms?: number
  browser_receive_ms?: number
  applied_epoch?: number
  applied_counter?: number
}

export interface CoverageV1 extends MeasurementEnvelopeV1 {
  event_type: 'coverage'
  expected_assignments: number
  observed_assignments: number
  completed: number
  missing_by_stage: Record<string, number>
  cells: Array<{ cell_id: string; expected: number; observed: number }>
  exclusions: string[]
  contamination_rate: number
  join_success_rate: number
  ground_truth_coverage: number
  claim_status: MeasurementClaimStatus
}

export type MeasurementEventV1 =
  | AssignmentCreatedV1
  | ReadObservedV1
  | ShadowDecisionV1
  | WebRtcProbeV1
  | InvalidationObservedV1
  | CoverageV1

export interface EvidenceBundleManifestV2 {
  schema_version: 2
  bundle_id: string
  generated_at: string
  experiment_id: string
  claim_status: MeasurementClaimStatus
  commit_sha: string
  working_tree_dirty: boolean
  build_digest: string
  protocol_version: string
  config_digest: string
  schema_digest: string
  query_digest: string
  redaction_version: string
  assignment_spec_path: string
  coverage_path: string
  artifacts: Array<{ path: string; sha256: string; bytes: number }>
  source_bundle_refs: string[]
  limitations: string[]
  operator_kind: 'automation' | 'operator' | 'mixed'
}

const COMMON_REQUIRED = [
  'schema_version', 'event_type', 'event_id', 'event_time_server_ms', 'experiment_id',
  'arm', 'assignment_id', 'commit_sha', 'build_digest', 'protocol_version',
  'config_digest', 'sample_probability', 'region_coarse',
] as const

const COMMON_OPTIONAL = [
  'run_id', 'request_id', 'session_id_ephemeral', 'tenant_hash_epoch', 'key_hash_epoch',
  'consent_version', 'browser_engine_major', 'os_major', 'device_class', 'visibility_state',
  'monotonic_offset_ms', 'clock_uncertainty_ms',
] as const

const SENSITIVE_FIELD = /^(?:ip|ip_address|sdp|token|authorization|secret|password|credential|email|url|full_url|user_agent|tenant_id|user_id|device_id|payload|content)$/i
const commitPattern = /^[0-9a-f]{7,64}$/i
const digestPattern = /^[0-9a-f]{64}$/i
const reasonPattern = /^[a-z][a-z0-9_-]{2,63}$/i

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}

function assertRecord(value: unknown, path: string): asserts value is JsonRecord {
  if (!isRecord(value)) fail(path, 'must be an object')
}

function assertAllowedKeys(value: JsonRecord, required: readonly string[], optional: readonly string[], path: string): void {
  const allowed = new Set([...required, ...optional])
  for (const key of required) if (!(key in value)) fail(`${path}.${key}`, 'is required')
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown field')
}

function assertNoSensitiveFields(value: unknown, path = '$', seen = new Set<unknown>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveFields(entry, `${path}[${index}]`, seen))
    return
  }
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    if (SENSITIVE_FIELD.test(key)) fail(`${path}.${key}`, 'sensitive/raw field is forbidden')
    assertNoSensitiveFields(child, `${path}.${key}`, seen)
  }
}

function stringField(value: JsonRecord, key: string, path: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.trim() === '') fail(`${path}.${key}`, 'must be a non-empty string')
  return field
}

function numberField(value: JsonRecord, key: string, path: string, options: { integer?: boolean; min?: number; max?: number } = {}): number {
  const field = value[key]
  if (typeof field !== 'number' || !Number.isFinite(field)) fail(`${path}.${key}`, 'must be a finite number')
  if (options.integer && !Number.isSafeInteger(field)) fail(`${path}.${key}`, 'must be a safe integer')
  if (options.min !== undefined && field < options.min) fail(`${path}.${key}`, `must be >= ${options.min}`)
  if (options.max !== undefined && field > options.max) fail(`${path}.${key}`, `must be <= ${options.max}`)
  return field
}

function booleanField(value: JsonRecord, key: string, path: string): boolean {
  if (typeof value[key] !== 'boolean') fail(`${path}.${key}`, 'must be boolean')
  return value[key]
}

function optionalNumber(value: JsonRecord, key: string, path: string, options: { integer?: boolean; min?: number } = {}): void {
  if (value[key] !== undefined) numberField(value, key, path, options)
}

function optionalString(value: JsonRecord, key: string, path: string): void {
  if (value[key] !== undefined) stringField(value, key, path)
}

function enumField<T extends string>(value: JsonRecord, key: string, allowed: readonly T[], path: string): T {
  const field = stringField(value, key, path)
  if (!allowed.includes(field as T)) fail(`${path}.${key}`, `must be one of ${allowed.join(', ')}`)
  return field as T
}

function assertCommon(value: JsonRecord, path: string): void {
  if (value['schema_version'] !== 1) fail(`${path}.schema_version`, 'must be 1')
  enumField(value, 'event_type', MEASUREMENT_EVENT_TYPES, path)
  enumField(value, 'arm', MEASUREMENT_ARMS, path)
  for (const key of ['event_id', 'experiment_id', 'assignment_id', 'protocol_version', 'region_coarse']) stringField(value, key, path)
  numberField(value, 'event_time_server_ms', path, { integer: true, min: 0 })
  numberField(value, 'sample_probability', path, { min: Number.MIN_VALUE, max: 1 })
  if (!commitPattern.test(stringField(value, 'commit_sha', path))) fail(`${path}.commit_sha`, 'must be a 7-64 character hexadecimal Git hash')
  for (const key of ['build_digest', 'config_digest']) {
    if (!digestPattern.test(stringField(value, key, path))) fail(`${path}.${key}`, 'must be a SHA-256 hexadecimal digest')
  }
  COMMON_OPTIONAL.filter((key) => !key.endsWith('_ms')).forEach((key) => optionalString(value, key, path))
  optionalNumber(value, 'monotonic_offset_ms', path)
  optionalNumber(value, 'clock_uncertainty_ms', path, { min: 0 })
}

function assertReasonCodes(value: unknown, path: string): void {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  for (let index = 0; index < value.length; index += 1) {
    const reason = value[index]
    if (typeof reason !== 'string' || !reasonPattern.test(reason)) fail(`${path}[${index}]`, 'must be a stable reason code')
  }
}

export function assertMeasurementEvent(value: unknown, path = '$'): asserts value is MeasurementEventV1 {
  assertRecord(value, path)
  assertNoSensitiveFields(value, path)
  const eventType = enumField(value, 'event_type', MEASUREMENT_EVENT_TYPES, path)
  const required: string[] = [...COMMON_REQUIRED]
  const optional: string[] = [...COMMON_OPTIONAL]

  if (eventType === 'assignment_created') {
    required.push('assignment_unit', 'registry_version', 'cell_id', 'population', 'assignment_hash_version', 'eligibility_state')
    optional.push('exclusion_reason')
  } else if (eventType === 'read_observed') {
    required.push('conventional_path', 'http_status', 'latency_ms', 'response_bytes', 'object_class', 'size_bucket', 'auth_scope_class', 'telemetry_complete')
    optional.push('cdn_cache_status', 'cdn_age_ms', 'returned_epoch', 'returned_counter', 'authoritative_epoch', 'authoritative_counter', 'k_versions', 't_ms', 'proof_age_ms', 'admission_result', 'admission_reason')
  } else if (eventType === 'shadow_decision') {
    required.push('shadow_mode', 'eligible', 'would_choose', 'actual_path', 'policy_version', 'reason_codes', 'decision_latency_ms', 'mismatch_class')
    optional.push('candidate_epoch', 'candidate_counter', 'would_admit')
  } else if (eventType === 'webrtc_probe') {
    required.push('topology_label', 'probe_phase', 'pair_role', 'attempt_number', 'signaling_state', 'ice_state', 'datachannel_state', 'duration_ms', 'useful_bytes', 'control_bytes', 'payload_digest_verified')
    optional.push('selected_candidate_type', 'relay_transport', 'ip_family', 'rtt_ms', 'failure_stage', 'failure_reason', 'turn_region', 'network_transition', 'lifecycle_state')
  } else if (eventType === 'invalidation_observed') {
    required.push('invalidation_id', 'object_class', 'authoritative_epoch', 'authoritative_counter', 'publish_ms', 'duplicate', 'reordered', 'outcome')
    optional.push('edge_receive_ms', 'browser_receive_ms', 'applied_epoch', 'applied_counter')
  } else {
    required.push('expected_assignments', 'observed_assignments', 'completed', 'missing_by_stage', 'cells', 'exclusions', 'contamination_rate', 'join_success_rate', 'ground_truth_coverage', 'claim_status')
  }

  assertAllowedKeys(value, required, optional, path)
  assertCommon(value, path)

  if (eventType === 'assignment_created') {
    enumField(value, 'assignment_unit', ['session', 'request', 'probe_pair'], path)
    for (const key of ['registry_version', 'cell_id', 'population', 'assignment_hash_version']) stringField(value, key, path)
    enumField(value, 'eligibility_state', ['eligible', 'ineligible', 'unknown'], path)
    optionalString(value, 'exclusion_reason', path)
  } else if (eventType === 'read_observed') {
    enumField(value, 'conventional_path', ['origin', 'cdn', 'sw'], path)
    numberField(value, 'http_status', path, { integer: true, min: 100, max: 599 })
    for (const key of ['latency_ms', 'response_bytes']) numberField(value, key, path, { min: 0 })
    for (const key of ['object_class', 'size_bucket', 'auth_scope_class']) stringField(value, key, path)
    booleanField(value, 'telemetry_complete', path)
    ;['cdn_age_ms', 'returned_epoch', 'returned_counter', 'authoritative_epoch', 'authoritative_counter', 'k_versions', 't_ms', 'proof_age_ms'].forEach((key) => optionalNumber(value, key, path, { min: 0 }))
    optionalString(value, 'cdn_cache_status', path)
    optionalString(value, 'admission_reason', path)
    if (value['admission_result'] !== undefined) enumField(value, 'admission_result', ['admitted', 'rejected', 'not_evaluated'], path)
  } else if (eventType === 'shadow_decision') {
    enumField(value, 'shadow_mode', ['S1', 'S2', 'S3'], path)
    booleanField(value, 'eligible', path)
    enumField(value, 'would_choose', ['origin', 'cdn', 'sw', 'peer', 'none'], path)
    enumField(value, 'actual_path', ['origin', 'cdn', 'sw'], path)
    stringField(value, 'policy_version', path)
    assertReasonCodes(value['reason_codes'], `${path}.reason_codes`)
    numberField(value, 'decision_latency_ms', path, { min: 0 })
    stringField(value, 'mismatch_class', path)
    optionalNumber(value, 'candidate_epoch', path, { integer: true, min: 0 })
    optionalNumber(value, 'candidate_counter', path, { integer: true, min: 0 })
    if (value['would_admit'] !== undefined && typeof value['would_admit'] !== 'boolean') fail(`${path}.would_admit`, 'must be boolean')
  } else if (eventType === 'webrtc_probe') {
    for (const key of ['topology_label', 'probe_phase', 'signaling_state', 'ice_state', 'datachannel_state']) stringField(value, key, path)
    enumField(value, 'pair_role', ['initiator', 'responder'], path)
    numberField(value, 'attempt_number', path, { integer: true, min: 1 })
    for (const key of ['duration_ms', 'useful_bytes', 'control_bytes']) numberField(value, key, path, { min: 0 })
    booleanField(value, 'payload_digest_verified', path)
    if (value['selected_candidate_type'] !== undefined) enumField(value, 'selected_candidate_type', ['host', 'srflx', 'relay', 'unknown'], path)
    if (value['ip_family'] !== undefined) enumField(value, 'ip_family', ['ipv4', 'ipv6', 'nat64', 'unknown'], path)
    ;['relay_transport', 'failure_stage', 'failure_reason', 'turn_region', 'network_transition', 'lifecycle_state'].forEach((key) => optionalString(value, key, path))
    optionalNumber(value, 'rtt_ms', path, { min: 0 })
  } else if (eventType === 'invalidation_observed') {
    for (const key of ['invalidation_id', 'object_class', 'outcome']) stringField(value, key, path)
    for (const key of ['authoritative_epoch', 'authoritative_counter', 'publish_ms']) numberField(value, key, path, { integer: true, min: 0 })
    booleanField(value, 'duplicate', path)
    booleanField(value, 'reordered', path)
    ;['edge_receive_ms', 'browser_receive_ms', 'applied_epoch', 'applied_counter'].forEach((key) => optionalNumber(value, key, path, { integer: true, min: 0 }))
  } else {
    for (const key of ['expected_assignments', 'observed_assignments', 'completed']) numberField(value, key, path, { integer: true, min: 0 })
    for (const key of ['contamination_rate', 'join_success_rate', 'ground_truth_coverage']) numberField(value, key, path, { min: 0, max: 1 })
    enumField(value, 'claim_status', MEASUREMENT_CLAIM_STATUSES, path)
    assertRecord(value['missing_by_stage'], `${path}.missing_by_stage`)
    for (const [stage, count] of Object.entries(value['missing_by_stage'])) {
      if (!reasonPattern.test(stage)) fail(`${path}.missing_by_stage.${stage}`, 'invalid stage code')
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) fail(`${path}.missing_by_stage.${stage}`, 'must be a non-negative integer')
    }
    if (!Array.isArray(value['cells'])) fail(`${path}.cells`, 'must be an array')
    value['cells'].forEach((cell, index) => {
      assertRecord(cell, `${path}.cells[${index}]`)
      assertAllowedKeys(cell, ['cell_id', 'expected', 'observed'], [], `${path}.cells[${index}]`)
      stringField(cell, 'cell_id', `${path}.cells[${index}]`)
      numberField(cell, 'expected', `${path}.cells[${index}]`, { integer: true, min: 0 })
      numberField(cell, 'observed', `${path}.cells[${index}]`, { integer: true, min: 0 })
    })
    if (!Array.isArray(value['exclusions']) || value['exclusions'].some((item) => typeof item !== 'string')) fail(`${path}.exclusions`, 'must be a string array')
  }
}

const BUNDLE_REQUIRED = [
  'schema_version', 'bundle_id', 'generated_at', 'experiment_id', 'claim_status',
  'commit_sha', 'working_tree_dirty', 'build_digest', 'protocol_version', 'config_digest',
  'schema_digest', 'query_digest', 'redaction_version', 'assignment_spec_path',
  'coverage_path', 'artifacts', 'source_bundle_refs', 'limitations', 'operator_kind',
] as const

export function assertEvidenceBundleManifest(value: unknown, path = '$'): asserts value is EvidenceBundleManifestV2 {
  assertRecord(value, path)
  assertNoSensitiveFields(value, path)
  assertAllowedKeys(value, BUNDLE_REQUIRED, [], path)
  if (value['schema_version'] !== 2) fail(`${path}.schema_version`, 'must be 2')
  for (const key of ['bundle_id', 'experiment_id', 'protocol_version', 'redaction_version', 'assignment_spec_path', 'coverage_path']) stringField(value, key, path)
  if (Number.isNaN(Date.parse(stringField(value, 'generated_at', path)))) fail(`${path}.generated_at`, 'must be ISO-8601')
  enumField(value, 'claim_status', MEASUREMENT_CLAIM_STATUSES, path)
  enumField(value, 'operator_kind', ['automation', 'operator', 'mixed'], path)
  if (!commitPattern.test(stringField(value, 'commit_sha', path))) fail(`${path}.commit_sha`, 'must be a Git hash')
  booleanField(value, 'working_tree_dirty', path)
  for (const key of ['build_digest', 'config_digest', 'schema_digest', 'query_digest']) {
    if (!digestPattern.test(stringField(value, key, path))) fail(`${path}.${key}`, 'must be a SHA-256 hexadecimal digest')
  }
  if (!Array.isArray(value['artifacts']) || value['artifacts'].length === 0) fail(`${path}.artifacts`, 'must contain at least one artifact')
  value['artifacts'].forEach((artifact, index) => {
    assertRecord(artifact, `${path}.artifacts[${index}]`)
    assertAllowedKeys(artifact, ['path', 'sha256', 'bytes'], [], `${path}.artifacts[${index}]`)
    stringField(artifact, 'path', `${path}.artifacts[${index}]`)
    if (!digestPattern.test(stringField(artifact, 'sha256', `${path}.artifacts[${index}]`))) fail(`${path}.artifacts[${index}].sha256`, 'must be a SHA-256 hexadecimal digest')
    numberField(artifact, 'bytes', `${path}.artifacts[${index}]`, { integer: true, min: 0 })
  })
  for (const key of ['source_bundle_refs', 'limitations']) {
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== 'string')) fail(`${path}.${key}`, 'must be a string array')
  }
}

export function parseMeasurementEventJson(raw: string, source = 'measurement event'): MeasurementEventV1 {
  let value: unknown
  try { value = JSON.parse(raw) as unknown } catch { throw new Error(`${source}: malformed JSON`) }
  assertMeasurementEvent(value, source)
  return value
}

export function parseEvidenceBundleManifestJson(raw: string, source = 'evidence bundle'): EvidenceBundleManifestV2 {
  let value: unknown
  try { value = JSON.parse(raw) as unknown } catch { throw new Error(`${source}: malformed JSON`) }
  assertEvidenceBundleManifest(value, source)
  return value
}
