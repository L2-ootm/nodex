import { readFile } from 'node:fs/promises'
import { economicLedger, type EconomicRead, type MarginalPrices } from '../src/shared/economic-ledger.js'
import type { ControlObservation } from '../src/shared/control-meter.js'

const [bundlePath, pricePath] = process.argv.slice(2)
if (!bundlePath) throw new Error('Usage: npm run economics:evaluate -- evidence.json [calibrated-prices.json]')
const bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as Record<string, unknown>
const run = (bundle['runEvidence'] ?? bundle) as {
  reads?: EconomicRead[]; controlObservations?: ControlObservation[];
  economics?: { startedAt: number; endedAt: number; controlCoverageComplete?: boolean };
}
if (!Array.isArray(run.reads) || !Array.isArray(run.controlObservations) || !run.economics) {
  throw new Error('Bundle lacks attributed reads, control observations or exposure interval')
}
const prices = pricePath ? JSON.parse(await readFile(pricePath, 'utf8')) as MarginalPrices : undefined
console.log(JSON.stringify(economicLedger(run.reads, run.controlObservations,
  run.economics.startedAt, run.economics.endedAt, prices, run.economics.controlCoverageComplete === true), null, 2))
