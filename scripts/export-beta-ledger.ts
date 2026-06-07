import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createBetaStore } from '../src/server/beta-coordinator.js'

const dataDir = process.env['NODEX_BETA_DATA_DIR'] ?? 'beta-data'
const outDir = process.env['NODEX_BETA_EXPORT_DIR'] ?? 'test-results'
const store = createBetaStore(dataDir)
const ledger = await store.readLedger()

await mkdir(outDir, { recursive: true })

const jsonPath = path.join(outDir, 'nodex-beta-ledger.json')
const mdPath = path.join(outDir, 'nodex-beta-ledger.md')

await writeFile(jsonPath, `${JSON.stringify(ledger, null, 2)}\n`)

const rows = ledger.participants.map((participant) =>
  `| ${participant.name} | ${participant.city ?? ''} | ${participant.country ?? ''} | ${participant.networkLabel ?? ''} | ${participant.evidenceCount} | ${participant.consentToCredit ? 'yes' : 'no'} | ${participant.contributionNote ?? ''} |`
)

await writeFile(mdPath, [
  '# Nodex Beta Contributor Ledger',
  '',
  `Generated: ${ledger.generatedAt}`,
  '',
  `Notice: ${ledger.notice}`,
  '',
  '| Name | City | Country | Network | Evidence Count | Credit Consent | Contribution Note |',
  '|------|------|---------|---------|----------------|----------------|-------------------|',
  ...rows,
  '',
  '## Evidence Count',
  '',
  `Total evidence records: ${ledger.evidence.length}`,
  '',
].join('\n'))

console.log(`[nodex] wrote ${jsonPath}`)
console.log(`[nodex] wrote ${mdPath}`)
