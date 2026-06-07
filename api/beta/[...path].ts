import { handle } from 'hono/vercel'
import { DEFAULT_SIGNALING_URL } from '../../src/shared/config.js'
import { createBetaCoordinatorApp, parseInviteTokensWithMeta } from '../../src/server/beta-coordinator.js'

export const config = {
  runtime: 'nodejs',
}

function parseAdminTokens(): string[] {
  return (process.env['NODEX_BETA_ADMIN_TOKENS'] ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
}

function parseAllowedOrigins(): string[] {
  return (process.env['NODEX_BETA_ALLOWED_ORIGINS'] ?? process.env['NODEX_BETA_APP_ORIGIN'] ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean)
}

const { tokens, tokenMeta } = parseInviteTokensWithMeta()

const app = createBetaCoordinatorApp({
  dataDir: process.env['NODEX_BETA_DATA_DIR'] ?? '/tmp/nodex-beta-data',
  inviteTokens: tokens,
  adminTokens: parseAdminTokens(),
  tokenMeta,
  appOrigin: process.env['NODEX_BETA_APP_ORIGIN'] ?? 'https://nodex-beta.vercel.app/',
  signalingUrl: process.env['NODEX_BETA_SIGNALING_URL'] ?? DEFAULT_SIGNALING_URL,
  allowedOrigins: parseAllowedOrigins(),
})

const handler = handle(app)

export const GET = handler
export const POST = handler
export const OPTIONS = handler
