/** Complete loopback beta API: protocol, invitations and HTTP signaling. */
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createBetaCoordinatorApp, parseInviteTokensWithMeta } from './beta-coordinator.js'
import { app as protocol } from './mock-api.js'
import { app as signaling } from '../../api/signal/[...path].js'
import { app as turn } from '../../api/turn-credentials.js'
import { validateBetaToken } from '../../api/_lib/auth.js'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function createLocalBetaStack(): Hono {
  if (process.env['NODE_ENV'] === 'production' || process.env['SUPABASE_URL'] || process.env['NODEX_BETA_STORAGE_DRIVER'] === 'supabase') {
    throw new Error('Local beta stack requires development mode without a hosted database')
  }
  process.env['NODEX_BETA_TOKENS'] ??= 'nodex-tester-local-development'
  process.env['NODEX_BETA_ADMIN_TOKENS'] ??= 'nodex-admin-local-development'
  const { tokens, tokenMeta } = parseInviteTokensWithMeta()
  const beta = createBetaCoordinatorApp({
    dataDir: process.env['NODEX_BETA_DATA_DIR'] ?? 'beta-data', inviteTokens: tokens, tokenMeta,
    adminTokens: process.env['NODEX_BETA_ADMIN_TOKENS']!.split(',').map(token => token.trim()).filter(Boolean),
    appOrigin: process.env['NODEX_BETA_APP_ORIGIN'] ?? 'http://localhost:4174',
    signalingUrl: `http://localhost:${process.env['NODEX_BETA_PORT'] ?? 3003}/api/signal`,
    allowedOrigins: [process.env['NODEX_BETA_APP_ORIGIN'] ?? 'http://localhost:4174','http://localhost:4175'],
  })
  const app = new Hono()
  app.use('/api/session-key', async (c, next) => {
    if (c.req.method !== 'OPTIONS' && !await validateBetaToken(c.req.raw, 'tester')) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  })
  app.route('/', beta)
  app.route('/', signaling)
  app.route('/', turn)
  app.route('/', protocol)
  return app
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  serve({ fetch: createLocalBetaStack().fetch, port: Number(process.env['NODEX_BETA_PORT'] ?? 3003), hostname: '127.0.0.1' }, () => {
    console.log('[Nodex] Local beta API ready at http://localhost:3003; local-only invitation: nodex-tester-local-development')
  })
}
