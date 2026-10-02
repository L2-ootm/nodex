import type { ControlObservation } from './control-meter.js'

export type ReadArm = 'origin-control' | 'sdk-cache' | 'sdk-auto'
export interface EconomicRead {
  requestId: string
  arm: ReadArm
  key: string
  version: number
  digest: string
  source: 'sw-cache' | 'peer-fetch' | 'server-fallback'
  applicationBytes: number
  latencyMs: number
}

/** Explicit calibrated marginal rates; free-tier/list prices are not inferred. */
export interface MarginalPrices {
  originRequestUsd: number
  controlRequestUsd: number
  measuredRelayAndDatabaseUsd: number
  otherIncrementalUsd: number
  calibrationReference: string
}

export function economicLedger(reads: EconomicRead[], controls: ControlObservation[],
  startedAt: number, endedAt: number, prices?: MarginalPrices, coverageComplete = false) {
  const hours = (endedAt - startedAt) / 3_600_000
  if (!Number.isFinite(hours) || hours <= 0) throw new TypeError('invalid exposure interval')
  const unique = new Map<string, EconomicRead>()
  let conflictingIds = false
  for (const read of reads) {
    if (!read.requestId || !['origin-control','sdk-cache','sdk-auto'].includes(read.arm) ||
      !['sw-cache','peer-fetch','server-fallback'].includes(read.source) ||
      typeof read.key !== 'string' || read.key.length > 256 || !Number.isSafeInteger(read.version) || read.version < 1 ||
      !/^[a-f0-9]{64}$/.test(read.digest) || !Number.isSafeInteger(read.applicationBytes) || read.applicationBytes < 0 ||
      !Number.isFinite(read.latencyMs) || read.latencyMs < 0) throw new TypeError('invalid read observation')
    const existing = unique.get(read.requestId)
    if (existing && JSON.stringify(existing) !== JSON.stringify(read)) conflictingIds = true
    else unique.set(read.requestId, read)
  }
  const byArm = Object.fromEntries((['origin-control','sdk-cache','sdk-auto'] as const).map(arm => {
    const selected = [...unique.values()].filter(read => read.arm === arm)
    return [arm, { reads: selected.length, originRequests: selected.filter(r => r.source === 'server-fallback').length,
      localReads: selected.filter(r => r.source === 'sw-cache').length,
      peerReads: selected.filter(r => r.source === 'peer-fetch').length,
      applicationBytes: selected.reduce((sum, r) => sum + r.applicationBytes, 0),
      latencyMs: selected.map(r => r.latencyMs),
      workload: selected.map(r => `${r.key}:${r.version}:${r.digest}`) }]
  })) as Record<ReadArm, { reads: number; originRequests: number; localReads: number; peerReads: number;
    applicationBytes: number; latencyMs: number[]; workload: string[] }>
  const matched = byArm['origin-control'].reads > 0 && !conflictingIds &&
    JSON.stringify(byArm['origin-control'].workload) === JSON.stringify(byArm['sdk-cache'].workload) &&
    JSON.stringify(byArm['sdk-cache'].workload) === JSON.stringify(byArm['sdk-auto'].workload)
  const controlIds = new Map<string, ControlObservation>()
  let conflictingControlIds = false
  for (const sample of controls) {
    if (!sample || typeof sample.eventId !== 'string' || !sample.eventId || sample.eventId.length > 160 ||
      typeof sample.operation !== 'string' || sample.operation.length > 80 || typeof sample.complete !== 'boolean' ||
      !Number.isFinite(sample.startedAt) || !Number.isFinite(sample.durationMs) || sample.durationMs < 0 ||
      !Number.isInteger(sample.status) || sample.status < 0 || sample.status > 599 ||
      ![sample.requestBytes,sample.responseBytes].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new TypeError('invalid control observation')
    }
    if (sample.startedAt < startedAt || sample.startedAt > endedAt) continue
    const previous = controlIds.get(sample.eventId)
    if (previous && JSON.stringify(previous) !== JSON.stringify(sample)) conflictingControlIds = true
    else controlIds.set(sample.eventId, sample)
  }
  const control = [...controlIds.values()]
  const controlComplete = coverageComplete && !conflictingControlIds && control.every(c => c.complete && c.status > 0)
  if (prices && (['originRequestUsd','controlRequestUsd','measuredRelayAndDatabaseUsd','otherIncrementalUsd']
      .some(key => { const value = prices[key as keyof MarginalPrices];
        return typeof value !== 'number' || !Number.isFinite(value) || value < 0 }) || !prices.calibrationReference?.trim())) {
    throw new TypeError('invalid marginal price calibration')
  }
  const avoidedVsOrigin = byArm['origin-control'].originRequests - byArm['sdk-auto'].originRequests
  const avoidedVsLocal = byArm['sdk-cache'].originRequests - byArm['sdk-auto'].originRequests
  const estimate = prices && matched && controlComplete ?
    (avoidedVsLocal * prices.originRequestUsd - control.length * prices.controlRequestUsd -
      prices.measuredRelayAndDatabaseUsd - prices.otherIncrementalUsd) / hours : null
  return { schema_version: 1, startedAt, endedAt, observedBrowserHours: hours,
    matchedWorkload: matched, conflictingIds, conflictingControlIds, controlCoverageComplete: controlComplete, byArm, controlRequests: control.length,
    controlApplicationBytes: control.reduce((sum,c) => sum + c.requestBytes + c.responseBytes, 0),
    controlRequestsPerObservedBrowserHour: control.length / hours,
    avoidedOriginRequestsVsOriginControl: matched ? avoidedVsOrigin : null,
    avoidedOriginRequestsVsLocalCache: matched ? avoidedVsLocal : null,
    netSavingsUsdPerObservedBrowserHourEstimate: estimate,
    economicClaim: 'not_measured' as const,
    calibrationReference: prices?.calibrationReference ?? null,
    limitations: ['Sequential short browser benchmark; no CDN baseline or adoption proof.',
      'Decoded application bytes are not compressed wire bytes or billed origin egress.',
      'Estimate needs calibrated prices and complete TURN, RPC, CPU and control costs.',
      'No live billing reconciliation; this artifact cannot prove monetary savings.'] }
}
