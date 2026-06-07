import * as fs from 'fs/promises'
import {
  writeAcademicExport,
  writeExternalValidationExport,
} from '../tests/helpers/report-writer'
import type { ExternalValidationReport, Phase05Report } from '../tests/helpers/report-writer'

const inputCandidates = [
  'test-results/phase-05-metrics.json',
  'test-results/phase-06-demo-metrics.json',
]

async function readFirstExistingReport(): Promise<{ inputPath: string; report: Phase05Report } | null> {
  for (const inputPath of inputCandidates) {
    try {
      const raw = await fs.readFile(inputPath, 'utf8')
      return { inputPath, report: JSON.parse(raw) as Phase05Report }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw err
    }
  }

  return null
}

async function main(): Promise<void> {
  let wroteAny = false
  const phase05Input = await readFirstExistingReport()

  if (phase05Input) {
    const { inputPath, report } = phase05Input
    const { jsonPath, csvPath } = await writeAcademicExport(report)

    wroteAny = true
    console.log(`[nodex] read ${inputPath}`)
    console.log(`[nodex] wrote ${jsonPath}`)
    console.log(`[nodex] wrote ${csvPath}`)
  }

  try {
    const rawPhase7 = await fs.readFile('test-results/phase-07-external-validation.json', 'utf8')
    const phase7 = JSON.parse(rawPhase7) as ExternalValidationReport
    const phase7Paths = await writeExternalValidationExport(
      phase7,
      'test-results',
      'nodex-phase-07-external-validation'
    )
    wroteAny = true
    console.log('[nodex] read test-results/phase-07-external-validation.json')
    console.log(`[nodex] wrote ${phase7Paths.jsonPath}`)
    console.log(`[nodex] wrote ${phase7Paths.csvPath}`)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
  }

  if (!wroteAny) {
    throw new Error(
      `no metrics input found; expected one of: ${inputCandidates.join(', ')}, test-results/phase-07-external-validation.json`
    )
  }
}

main().catch((err) => {
  console.error('[nodex] metrics export failed:', err)
  process.exit(1)
})
