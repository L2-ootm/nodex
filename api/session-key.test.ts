import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from './session-key.js'

const token = 'nodex-session-key-tester'

describe('hosted session-key route', () => {
  beforeEach(() => {
    vi.stubEnv('NODEX_BETA_TOKENS', `${token}|Session Key Tester||`)
    vi.stubEnv('NODEX_BETA_ADMIN_TOKENS', '')
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'abc1234def567890abc1234def567890abc1234d')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('exposes the deployed API commit without exposing credentials', async () => {
    const response = await GET(new Request('http://localhost/api/session-key', {
      headers: { Authorization: `Bearer ${token}` },
    }))

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Nodex-Commit'))
      .toBe('abc1234def567890abc1234def567890abc1234d')
    expect(await response.text()).not.toContain(token)
  })
})
