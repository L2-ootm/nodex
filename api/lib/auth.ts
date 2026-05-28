export type BetaTokenRole = 'tester' | 'admin'

function parseTesterTokens(): string[] {
  const raw = process.env['NODEX_BETA_TOKENS'] ?? ''
  return raw.split(/,(?=nodex-)/)
    .map((entry) => entry.trim().split('|')[0]?.trim() ?? '')
    .filter((t) => t.startsWith('nodex-') && t.length > 0)
}

function parseAdminTokens(): string[] {
  return (process.env['NODEX_BETA_ADMIN_TOKENS'] ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

export function validateBetaToken(req: Request, role: BetaTokenRole): boolean {
  const header = req.headers.get('Authorization') ?? ''
  if (!header.startsWith('Bearer ')) return false
  const token = header.slice(7).trim()
  if (!token) return false

  const admins = parseAdminTokens()
  if (admins.includes(token)) return true          // admin passes all roles

  if (role === 'admin') return false               // non-admin token rejected for admin role

  return parseTesterTokens().includes(token)
}

export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}
