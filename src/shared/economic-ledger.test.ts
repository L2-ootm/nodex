import { describe, expect, it } from 'vitest'
import { economicLedger, type EconomicRead } from './economic-ledger.js'
const read = (arm: EconomicRead['arm'], source: EconomicRead['source']): EconomicRead => ({
  requestId: arm, arm, source, key: '/api/products/1', version: 1, digest: 'a'.repeat(64),
  applicationBytes: 100, latencyMs: 5,
})
describe('economic evidence ledger', () => {
  it('refuses price estimates when control observations were lost', () => {
    const reads = [read('origin-control','server-fallback'), read('sdk-cache','server-fallback'), read('sdk-auto','peer-fetch')]
    const report = economicLedger(reads, [], 1, 1001, { originRequestUsd: 0.01, controlRequestUsd: 0,
      measuredRelayAndDatabaseUsd: 0, otherIncrementalUsd: 0, calibrationReference: 'synthetic-test-only' }, false)
    expect(report.controlCoverageComplete).toBe(false)
    expect(report.netSavingsUsdPerObservedBrowserHourEstimate).toBeNull()
    expect(() => economicLedger(reads, [{ eventId: 'bad', requestBytes: -1 } as never], 1, 1001)).toThrow()
  })
  it('deduplicates delivery and credits P2P only against the local-cache control', () => {
    const cached = read('sdk-cache','sw-cache')
    const report = economicLedger([read('origin-control','server-fallback'), cached, cached,
      read('sdk-auto','peer-fetch')], [], 1000, 3_601_000,
      { originRequestUsd: 0.01, controlRequestUsd: 0, measuredRelayAndDatabaseUsd: 0.001,
        otherIncrementalUsd: 0, calibrationReference: 'synthetic-test-only' }, true)
    expect(report.matchedWorkload).toBe(true)
    expect(report.avoidedOriginRequestsVsLocalCache).toBe(0)
    expect(report.netSavingsUsdPerObservedBrowserHourEstimate).toBe(-0.001)
    expect(report.economicClaim).toBe('not_measured')
  })
  it('refuses economic comparison when payloads differ or observation identities conflict', () => {
    const reads = [read('origin-control','server-fallback'), read('sdk-cache','server-fallback'), read('sdk-auto','peer-fetch')]
    reads[2]!.version = 2
    expect(economicLedger(reads, [], 1, 1001).avoidedOriginRequestsVsOriginControl).toBe(null)
    expect(economicLedger([...reads, { ...reads[0]!, applicationBytes: 999 }], [], 1, 1001).conflictingIds).toBe(true)
  })
  it('keeps money unknown without rates and rejects invalid calibration', () => {
    expect(economicLedger([], [], 1, 1001).netSavingsUsdPerObservedBrowserHourEstimate).toBe(null)
    expect(() => economicLedger([], [], 1, 1001, { originRequestUsd: NaN } as never)).toThrow()
  })
  it('requires explicit control coverage even with matched workloads and calibrated prices', () => {
    const reads = [read('origin-control','server-fallback'), read('sdk-cache','server-fallback'), read('sdk-auto','peer-fetch')]
    const report = economicLedger(reads, [], 1, 1001, { originRequestUsd: 0.01, controlRequestUsd: 0,
      measuredRelayAndDatabaseUsd: 0, otherIncrementalUsd: 0, calibrationReference: 'synthetic-test-only' })
    expect(report.matchedWorkload).toBe(true)
    expect(report.controlCoverageComplete).toBe(false)
    expect(report.netSavingsUsdPerObservedBrowserHourEstimate).toBeNull()
  })
})
