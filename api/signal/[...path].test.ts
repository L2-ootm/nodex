import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET, POST } from './[...path].js'

const token = 'nodex-tester-api'

function authHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

async function postJson(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await POST(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  }))
  expect(response.status).toBe(200)
  return await response.json() as Record<string, unknown>
}

async function poll(roomId: string, nodeId: string): Promise<Record<string, unknown>> {
  const url = new URL('http://localhost/api/signal/poll')
  url.searchParams.set('roomId', roomId)
  url.searchParams.set('nodeId', nodeId)
  url.searchParams.set('after', '0')
  const response = await GET(new Request(url, {
    headers: authHeaders(),
  }))
  expect(response.status).toBe(200)
  return await response.json() as Record<string, unknown>
}

describe('HTTP signaling route', () => {
  beforeEach(() => {
    vi.stubEnv('NODEX_BETA_TOKENS', `${token}|API Tester||`)
    vi.stubEnv('NODEX_BETA_ADMIN_TOKENS', '')
    vi.stubEnv('SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_SECRET_KEY', '')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', '')
    vi.stubEnv('NODEX_BETA_STORAGE_DRIVER', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns active peers from poll so empty join lists can recover', async () => {
    const roomId = `poll-peers-${Date.now()}-${Math.random().toString(36).slice(2)}`

    await expect(postJson('/api/signal/join', { roomId, nodeId: 'node-a' }))
      .resolves.toMatchObject({ peers: [] })
    await postJson('/api/signal/join', { roomId, nodeId: 'node-b' })

    await expect(poll(roomId, 'node-a')).resolves.toMatchObject({
      peers: ['node-b'],
      polite: true,
    })
  })
})
