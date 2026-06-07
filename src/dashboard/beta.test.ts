import { describe, expect, it } from 'vitest'
import { buildBetaSessionPayload, buildLogBundle, collectBetaEvidencePayload } from './beta.js'

describe('beta dashboard payload helpers', () => {
  it('builds a session payload with explicit credit consent and trimmed fields', () => {
    const payload = buildBetaSessionPayload({
      name: '  Maria Tester  ',
      email: ' maria@example.test ',
      city: ' Sao Paulo ',
      country: ' BR ',
      networkLabel: ' home wifi ',
      consentToCredit: true,
      contributionNote: ' Ran LAN test. ',
    })

    expect(payload).toMatchObject({
      name: 'Maria Tester',
      email: 'maria@example.test',
      city: 'Sao Paulo',
      country: 'BR',
      networkLabel: 'home wifi',
      consentToCredit: true,
      contributionNote: 'Ran LAN test.',
    })
  })

  it('rejects missing name or missing credit consent before creating a beta session', () => {
    expect(() => buildBetaSessionPayload({ name: '', consentToCredit: true })).toThrow(/name/i)
    expect(() => buildBetaSessionPayload({ name: 'Ada', consentToCredit: false })).toThrow(/consent/i)
  })

  it('collects runtime, telemetry, and storage evidence from beta browser hooks', async () => {
    const payload = await collectBetaEvidencePayload({
      participantId: 'beta-123',
      roomId: 'beta-room',
      topologyLabel: 'lan-multi-machine',
      result: 'pass',
      notes: 'Connected on same LAN.',
      hooks: {
        __nodexPeerTelemetry: async () => [{ selected_candidate_type: 'host' }],
        __nodexStoragePressure: async () => ({ usage_ratio: 0.1 }),
        __nodexRuntimeConfig: () => ({ iceTransportPolicy: 'all' }),
        __nodexLifecycleSignals: () => [{ type: 'visibilitychange', hidden: true }],
        __nodexDeviceHints: () => ({ userAgent: 'vitest-mobile', mobile: true }),
      },
    })

    expect(payload.participantId).toBe('beta-123')
    expect(payload.telemetry).toEqual([{ selected_candidate_type: 'host' }])
    expect(payload.storagePressure).toEqual({ usage_ratio: 0.1 })
    expect(payload.runtimeConfig).toEqual({ iceTransportPolicy: 'all' })
    expect(payload.lifecycleSignals).toEqual([{ type: 'visibilitychange', hidden: true }])
    expect(payload.deviceHints).toEqual({ userAgent: 'vitest-mobile', mobile: true })
  })

  it('builds a tester log bundle with session identifiers', () => {
    const bundle = buildLogBundle([
      { time: '2026-05-24T00:00:00.000Z', level: 'info', message: 'Ran guided simulation.' },
    ], {
      participantId: 'beta-123',
      sessionToken: 'beta-session-123',
      roomId: 'beta-room',
      testUrl: 'http://localhost:4173/',
    })

    expect(bundle).toMatchObject({
      schema_version: 1,
      participantId: 'beta-123',
      roomId: 'beta-room',
    })
    expect(JSON.stringify(bundle)).toContain('Ran guided simulation')
  })
})
