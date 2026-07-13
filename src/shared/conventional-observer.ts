import {
  assertMeasurementEvent,
  type AssignmentCreatedV1,
  type MeasurementEventV1,
  type ReadObservedV1,
} from './measurement-contracts.js'

export type ConventionalArm = 'B0' | 'B1' | 'B2' | 'B3' | 'B4'
export type ConventionalPath = 'origin' | 'cdn' | 'sw'

export interface ObserverProvenanceV1 {
  experiment_id: string
  arm: ConventionalArm
  commit_sha: string
  build_digest: string
  protocol_version: string
  config_digest: string
  sample_probability: number
  region_coarse: string
  registry_version: string
  assignment_hash_version: string
}

export interface BeginObservationInput {
  assignment_id: string
  assignment_unit: 'session' | 'request'
  cell_id: string
  population: string
  eligibility_state: 'eligible' | 'ineligible' | 'unknown'
  sampled: boolean
  exclusion_reason?: string
  session_id_ephemeral?: string
  tenant_hash_epoch?: string
  key_hash_epoch?: string
}

export interface ConventionalObservationTicket {
  assignment: AssignmentCreatedV1
  started_at_ms: number
  sampled: boolean
}

export interface FinishObservationInput {
  conventional_path: ConventionalPath
  response_bytes: number
  object_class: string
  size_bucket: string
  auth_scope_class: string
  telemetry_complete: boolean
  request_id?: string
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

export interface ObserverDispatchFailure {
  code: 'observer_contract_rejected' | 'observer_sink_failed'
  stage: 'assignment' | 'read'
  event_type: 'assignment_created' | 'read_observed'
}

export interface ConventionalObserverRuntime {
  enabled: boolean
  provenance: ObserverProvenanceV1
  sink: (event: MeasurementEventV1) => void | Promise<void>
  now?: () => number
  idFactory?: () => string
  onFailure?: (failure: ObserverDispatchFailure) => void
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value }
}

function reportFailure(runtime: ConventionalObserverRuntime, failure: ObserverDispatchFailure): void {
  try { runtime.onFailure?.(failure) } catch { /* observer diagnostics cannot affect requests */ }
}

function dispatch(runtime: ConventionalObserverRuntime, event: MeasurementEventV1, stage: ObserverDispatchFailure['stage']): void {
  try {
    const result = runtime.sink(event)
    if (result && typeof (result as PromiseLike<void>).then === 'function') {
      void Promise.resolve(result).catch(() => reportFailure(runtime, {
        code: 'observer_sink_failed', stage, event_type: event.event_type as ObserverDispatchFailure['event_type'],
      }))
    }
  } catch {
    reportFailure(runtime, {
      code: 'observer_sink_failed', stage, event_type: event.event_type as ObserverDispatchFailure['event_type'],
    })
  }
}

function common(runtime: ConventionalObserverRuntime) {
  const { provenance } = runtime
  return {
    schema_version: 1 as const,
    experiment_id: provenance.experiment_id,
    arm: provenance.arm,
    commit_sha: provenance.commit_sha,
    build_digest: provenance.build_digest,
    protocol_version: provenance.protocol_version,
    config_digest: provenance.config_digest,
    sample_probability: provenance.sample_probability,
    region_coarse: provenance.region_coarse,
  }
}

export function beginConventionalObservation(
  runtime: ConventionalObserverRuntime,
  input: BeginObservationInput,
): ConventionalObservationTicket | null {
  if (!runtime.enabled) return null
  const now = runtime.now?.() ?? Date.now()
  const event: AssignmentCreatedV1 = {
    ...common(runtime),
    event_type: 'assignment_created',
    event_id: runtime.idFactory?.() ?? crypto.randomUUID(),
    event_time_server_ms: now,
    assignment_id: input.assignment_id,
    assignment_unit: input.assignment_unit,
    registry_version: runtime.provenance.registry_version,
    cell_id: input.cell_id,
    population: input.population,
    assignment_hash_version: runtime.provenance.assignment_hash_version,
    eligibility_state: input.eligibility_state,
    ...optional('exclusion_reason', input.exclusion_reason),
    ...optional('session_id_ephemeral', input.session_id_ephemeral),
    ...optional('tenant_hash_epoch', input.tenant_hash_epoch),
    ...optional('key_hash_epoch', input.key_hash_epoch),
  }
  try {
    assertMeasurementEvent(event)
  } catch {
    reportFailure(runtime, { code: 'observer_contract_rejected', stage: 'assignment', event_type: 'assignment_created' })
    return null
  }
  dispatch(runtime, event, 'assignment')
  return { assignment: event, started_at_ms: now, sampled: input.sampled }
}

export function finishConventionalObservation(
  runtime: ConventionalObserverRuntime,
  ticket: ConventionalObservationTicket | null,
  response: Response,
  input: FinishObservationInput,
): Response {
  if (!runtime.enabled || !ticket || !ticket.sampled) return response
  const now = runtime.now?.() ?? Date.now()
  const assignment = ticket.assignment
  const event: ReadObservedV1 = {
    ...common(runtime),
    event_type: 'read_observed',
    event_id: runtime.idFactory?.() ?? crypto.randomUUID(),
    event_time_server_ms: now,
    assignment_id: assignment.assignment_id,
    conventional_path: input.conventional_path,
    http_status: response.status,
    latency_ms: Math.max(0, now - ticket.started_at_ms),
    response_bytes: input.response_bytes,
    object_class: input.object_class,
    size_bucket: input.size_bucket,
    auth_scope_class: input.auth_scope_class,
    telemetry_complete: input.telemetry_complete,
    ...optional('request_id', input.request_id),
    ...optional('session_id_ephemeral', assignment.session_id_ephemeral),
    ...optional('tenant_hash_epoch', assignment.tenant_hash_epoch),
    ...optional('key_hash_epoch', assignment.key_hash_epoch),
    ...optional('cdn_cache_status', input.cdn_cache_status),
    ...optional('cdn_age_ms', input.cdn_age_ms),
    ...optional('returned_epoch', input.returned_epoch),
    ...optional('returned_counter', input.returned_counter),
    ...optional('authoritative_epoch', input.authoritative_epoch),
    ...optional('authoritative_counter', input.authoritative_counter),
    ...optional('k_versions', input.k_versions),
    ...optional('t_ms', input.t_ms),
    ...optional('proof_age_ms', input.proof_age_ms),
    ...optional('admission_result', input.admission_result),
    ...optional('admission_reason', input.admission_reason),
  }
  try {
    assertMeasurementEvent(event)
  } catch {
    reportFailure(runtime, { code: 'observer_contract_rejected', stage: 'read', event_type: 'read_observed' })
    return response
  }
  dispatch(runtime, event, 'read')
  return response
}
