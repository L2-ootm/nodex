import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { app } from './turn-credentials.js'
afterEach(() => vi.unstubAllEnvs())
describe('TURN credential contract', () => {
  it('issues actual timestamp-bound coturn HMAC credentials', async () => {
    vi.stubEnv('NODEX_BETA_ADMIN_TOKENS', 'turn-admin')
    vi.stubEnv('NODEX_TURN_URLS', 'turn:relay.example:3478')
    const secret = 's'.repeat(40)
    vi.stubEnv('NODEX_TURN_SHARED_SECRET', secret)
    const response = await app.request('/api/turn-credentials', { headers: { Authorization: 'Bearer turn-admin' } })
    const data = await response.json() as { credentialMode: string; expiresAt: number; iceServers: Array<{ username?: string; credential?: string }> }
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const server = data.iceServers[1]!
    expect(data.credentialMode).toBe('coturn-rest')
    expect(Number(server.username!.split(':')[0]) * 1000).toBe(data.expiresAt)
    expect(server.credential).toBe(createHmac('sha1', secret).update(server.username!).digest('base64'))
    expect(server.username).not.toContain('turn-admin')
  })
  it('does not invent expiration for static credentials', async () => {
    vi.stubEnv('NODEX_BETA_ADMIN_TOKENS', 'turn-admin')
    vi.stubEnv('NODEX_TURN_URLS', 'turn:relay.example:3478')
    vi.stubEnv('NODEX_TURN_SHARED_SECRET', '')
    vi.stubEnv('NODEX_TURN_USERNAME', 'static-user')
    vi.stubEnv('NODEX_TURN_CREDENTIAL', 'static-password')
    const response = await app.request('/api/turn-credentials', { headers: { Authorization: 'Bearer turn-admin' } })
    expect(await response.json()).toMatchObject({ credentialMode: 'static', expiresAt: null })
    vi.stubEnv('NODE_ENV', 'production')
    expect((await app.request('/api/turn-credentials', { headers: { Authorization: 'Bearer turn-admin' } })).status).toBe(503)
  })
})
