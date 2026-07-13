import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parseEvidenceBundleManifestJson,
  parseMeasurementEventJson,
} from '../src/shared/measurement-contracts.js'

export type MeasurementContractKind = 'event' | 'bundle' | 'schema'

function assertSchemaDocument(raw: string, source: string): void {
  let value: unknown
  try { value = JSON.parse(raw) as unknown } catch { throw new Error(`${source}: malformed JSON schema`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${source}: schema must be an object`)
  const schema = value as Record<string, unknown>
  if (schema['$schema'] !== 'https://json-schema.org/draft/2020-12/schema') throw new Error(`${source}: unsupported or missing $schema`)
  if (typeof schema['$id'] !== 'string' || !schema['$id']) throw new Error(`${source}: $id is required`)
  if (schema['type'] !== 'object' && !Array.isArray(schema['oneOf'])) throw new Error(`${source}: schema needs an object type or oneOf`)
}

export async function validateMeasurementContractFile(inputPath: string, kind: MeasurementContractKind): Promise<number> {
  const source = resolve(inputPath)
  const raw = await readFile(source, 'utf8')
  if (kind === 'schema') {
    assertSchemaDocument(raw, source)
    return 1
  }
  if (kind === 'bundle') {
    parseEvidenceBundleManifestJson(raw, source)
    return 1
  }

  const lines = inputPath.endsWith('.jsonl') ? raw.split(/\r?\n/).filter((line) => line.trim()) : [raw]
  if (lines.length === 0) throw new Error(`${source}: no measurement events found`)
  lines.forEach((line, index) => parseMeasurementEventJson(line, `${source}:${index + 1}`))
  return lines.length
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index >= 0) return args[index + 1]
  const inline = args.find((arg) => arg.startsWith(`${name}=`))
  return inline?.slice(name.length + 1)
}

export const HELP_TEXT = `Usage: tsx scripts/validate-measurement-contracts.ts --kind <event|bundle|schema> --input <path>

The validator is read-only and fails closed on malformed JSON, unknown fields,
missing provenance, invalid sampling, forbidden sensitive fields, or schema drift.
`

async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP_TEXT); return }
  const kind = option(args, '--kind')
  const input = option(args, '--input')
  if (kind !== 'event' && kind !== 'bundle' && kind !== 'schema') throw new Error('--kind must be event, bundle, or schema')
  if (!input) throw new Error('--input is required')
  const count = await validateMeasurementContractFile(input, kind)
  console.log(`[nodex] ${kind} contract valid: ${input} (${count} document${count === 1 ? '' : 's'})`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    console.error('[nodex] measurement contract validation failed:', error)
    process.exitCode = 1
  })
}
