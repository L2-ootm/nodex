import { describe, expect, it } from 'vitest'
import {
  beginConventionalObservation,
  finishConventionalObservation,
  type ConventionalObserverRuntime,
  type ObserverDispatchFailure,
} from './conventional-observer.js'
import type { MeasurementEventV1 } from './measurement-contracts.js'

const digest = 'a'.repeat(64)

function runtime(overrides: Partial<ConventionalObserverRuntime> = {}) {
  const events: MeasurementEventV1[] = []
  const failures: ObserverDispatchFailure[] = []
  let now = 1_784_000_000_000
  let id = 0
  const value: ConventionalObserverRuntime = {
    enabled: true,
    provenance: {
      experiment_id: 'observer-pilot-1', arm: 'B3', commit_sha: 'abcdef1234567',
      build_digest: digest, protocol_version: 'measurement-v1', config_digest: digest,
      sample_probability: 0.25, region_coarse: 'br-southeast',
      registry_version: 'registry-v1', assignment_hash_version: 'hmac-sha256-v1',
    },
    sink: (event) => { events.push(event) },
    now: () => now,
    idFactory: () => `event-${++id}`,
    onFailure: (failure) => { failures.push(failure) },
    ...overrides,
  }
  return { runtime: value, events, failures, advance: (ms: number) => { now += ms } }
}

const assignment = {
  assignment_id: 'assignment-1', assignment_unit: 'session' as const,
  cell_id: 'br-chromium-desktop', population: 'synthetic-pilot',
  eligibility_state: 'eligible' as const, sampled: true,
  session_id_ephemeral: 'session-ephemeral-1', key_hash_epoch: 'key-hash-epoch-1',
}

const outcome = {
  conventional_path: 'cdn' as const, response_bytes: 4, object_class: 'bounded',
  size_bucket: '1-16kb', auth_scope_class: 'public', telemetry_complete: true,
  returned_epoch: 1, returned_counter: 8,
}

describe('S0 conventional observer', () => {
  it('emits assignment before read and returns the identical response object', async () => {
    const state = runtime()
    const ticket = beginConventionalObservation(state.runtime, assignment)
    expect(state.events.map((event) => event.event_type)).toEqual(['assignment_created'])
    state.advance(12)
    const response = new Response('body', { status: 200, headers: { 'X-Test': 'same' } })
    const returned = finishConventionalObservation(state.runtime, ticket, response, outcome)
    expect(returned).toBe(response)
    expect(returned.status).toBe(200)
    expect(returned.headers.get('X-Test')).toBe('same')
    expect(await returned.text()).toBe('body')
    expect(state.events.map((event) => event.event_type)).toEqual(['assignment_created', 'read_observed'])
    expect(state.events[1]).toMatchObject({ latency_ms: 12, http_status: 200, assignment_id: 'assignment-1' })
  })

  it('does no work when disabled', () => {
    let calls = 0
    const state = runtime({ enabled: false, idFactory: () => { calls += 1; return 'never' } })
    const ticket = beginConventionalObservation(state.runtime, assignment)
    const response = new Response('body')
    expect(ticket).toBeNull()
    expect(finishConventionalObservation(state.runtime, ticket, response, outcome)).toBe(response)
    expect(state.events).toEqual([])
    expect(calls).toBe(0)
  })

  it('keeps unsampled assignments in the denominator without emitting a read', () => {
    const state = runtime()
    const ticket = beginConventionalObservation(state.runtime, { ...assignment, sampled: false })
    const response = new Response('body')
    expect(finishConventionalObservation(state.runtime, ticket, response, outcome)).toBe(response)
    expect(state.events.map((event) => event.event_type)).toEqual(['assignment_created'])
  })

  it('isolates synchronous and asynchronous sink failures', async () => {
    const sync = runtime({ sink: () => { throw new Error('secret-bearing sink failure') } })
    const syncTicket = beginConventionalObservation(sync.runtime, assignment)
    const response = new Response('body')
    expect(finishConventionalObservation(sync.runtime, syncTicket, response, outcome)).toBe(response)
    expect(sync.failures).toEqual([
      { code: 'observer_sink_failed', stage: 'assignment', event_type: 'assignment_created' },
      { code: 'observer_sink_failed', stage: 'read', event_type: 'read_observed' },
    ])

    const asyncFailure = runtime({ sink: async () => { throw new Error('async sink failure') } })
    beginConventionalObservation(asyncFailure.runtime, assignment)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(asyncFailure.failures).toEqual([
      { code: 'observer_sink_failed', stage: 'assignment', event_type: 'assignment_created' },
    ])
  })

  it('turns invalid observer configuration into a diagnostic, not a request failure', () => {
    const state = runtime({ provenance: { ...runtime().runtime.provenance, sample_probability: 0 } })
    expect(beginConventionalObservation(state.runtime, assignment)).toBeNull()
    expect(state.events).toEqual([])
    expect(state.failures).toEqual([
      { code: 'observer_contract_rejected', stage: 'assignment', event_type: 'assignment_created' },
    ])
  })
})
