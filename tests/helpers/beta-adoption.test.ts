import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createBetaCoordinatorApp } from '../../src/server/beta-coordinator.js'
import { GET as sessionKey } from '../../api/session-key.js'
let app: ReturnType<typeof createBetaCoordinatorApp>
const admin = { Authorization: 'Bearer nodex-admin-regression', 'Content-Type': 'application/json' }
beforeEach(() => {
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', '')
  vi.stubEnv('NODEX_BETA_STORAGE_DRIVER', '')
  vi.stubEnv('NODEX_BETA_DATA_DIR', `test-results/beta-adoption-${crypto.randomUUID()}`)
  vi.stubEnv('NODEX_BETA_ADMIN_TOKENS', 'nodex-admin-regression')
  vi.stubEnv('NODEX_BETA_TOKENS', '')
  app = createBetaCoordinatorApp({ dataDir: process.env['NODEX_BETA_DATA_DIR']!, inviteTokens: [], adminTokens: ['nodex-admin-regression'] })
})
afterEach(() => vi.unstubAllEnvs())
async function invite() {
  const response = await app.request('/api/beta/tokens', { method: 'POST', headers: admin,
    body: JSON.stringify({ role: 'tester', label: 'synthetic', maxSessions: 1 }) })
  expect(response.status).toBe(201)
  return (await response.json()).token as string
}
it('a newly issued invite is recognized by the protocol and revocation takes effect', async () => {
  const token = await invite()
  const headers = { Authorization: `Bearer ${token}` }
  expect((await sessionKey(new Request('https://local/api/session-key', { headers }))).status).toBe(200)
  const list = await app.request('/api/beta/tokens', { headers: admin })
  const records = await list.json()
  const created = records.createdTokens.find((record: any) => record.label === 'synthetic')
  const revoked = await app.request(`/api/beta/tokens/${created.tokenId}/revoke`, { method: 'POST', headers: admin })
  expect(revoked.status).toBe(200)
  expect((await sessionKey(new Request('https://local/api/session-key', { headers }))).status).toBe(401)
})
it('consumes one-session invites atomically and retries the same enrollment idempotently', async () => {
  const token = await invite()
  const input = { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Synthetic participant', consentToCredit: false }) }
  const key = crypto.randomUUID()
  const firstInput = { ...input, headers: { ...input.headers, 'Idempotency-Key': key } }
  const secondInput = { ...input, headers: { ...input.headers, 'Idempotency-Key': crypto.randomUUID() } }
  const responses = await Promise.all([app.request('/api/beta/sessions', firstInput), app.request('/api/beta/sessions', secondInput)])
  expect(responses.filter(r => r.status === 201)).toHaveLength(1)
  const winning = responses.findIndex(r => r.status === 201)
  const original = await responses[winning].json()
  const replay = await app.request('/api/beta/sessions', [firstInput, secondInput][winning])
  expect(replay.status).toBe(201)
  expect((await replay.json()).sessionToken).toBe(original.sessionToken)
})
it('returns a client error for null profiles rather than an internal error', async () => {
  const token = await invite()
  const response = await app.request('/api/beta/sessions', { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: 'null' })
  expect(response.status).toBe(400)
})
