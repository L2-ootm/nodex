export type BetaTokenRole = 'tester' | 'admin'

function parseTesterTokens(): string[] {
  const raw = process.env['NODEX_BETA_TOKENS'] ?? ''
  return splitTokenEntries(raw)
    .map((entry) => entry.trim().split('|')[0]?.trim() ?? '')
    .filter(Boolean)
}

function parseAdminTokens(): string[] {
  return (process.env['NODEX_BETA_ADMIN_TOKENS'] ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

export async function validateBetaToken(req: Request, role: BetaTokenRole): Promise<boolean> {
  const header = req.headers.get('Authorization') ?? ''
  if (!header.startsWith('Bearer ')) return false
  const token = header.slice(7).trim()
  if (!token) return false

  const admins = parseAdminTokens()
  if (matchesEnvironmentToken(admins, token)) return true

  if (role === 'tester' && matchesEnvironmentToken(parseTesterTokens(), token)) return true
  try {
    const store = createConfiguredBetaStore(process.env['NODEX_BETA_DATA_DIR'] ?? (process.env['VERCEL'] === '1' ? '/tmp/nodex-beta-data' : 'beta-data'))
    const hash = createHash('sha256').update(token).digest('hex')
    const record = await store.findToken(hash)
    return !!record && isTokenUsable(record) && (role === 'tester' || record.role === 'admin')
  } catch { return false }
}

export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}
import { createHash, timingSafeEqual } from 'node:crypto'
import { createConfiguredBetaStore, isTokenUsable, splitTokenEntries } from '../../src/server/beta-coordinator.js'

function matchesEnvironmentToken(tokens: string[], token: string): boolean {
  const digest = createHash('sha256').update(token).digest()
  let matched = false
  for (const candidate of tokens) matched = timingSafeEqual(digest, createHash('sha256').update(candidate).digest()) || matched
  return matched
}
