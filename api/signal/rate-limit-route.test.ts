import { describe, expect, it, vi } from 'vitest'
import { app } from './[...path].js'

vi.mock('../../src/server/http-signaling-store.js', () => ({ executeSignal: vi.fn(async () => ({ status: 200 })) }))

describe('signaling rate limit', () => {
  it('throttles repeated joins from one credential with 429 and leaves others unaffected', async () => {
    const join = (token: string) => app.request('/api/signal/join', { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: 'r', nodeId: 'n' }) })
    let limited = 0
    for (let i = 0; i < 40; i++) if ((await join('flooder')).status === 429) limited++
    expect(limited).toBe(10) // limit is 30 per minute
    expect((await join('other')).status).not.toBe(429)
  })
})
