import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GET, POST } from './[...path].js'
import { createSignalingInvalidationSink } from '../../src/server/signaling-invalidation-sink.js'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc }) }))
let room: string
const tester = { Authorization: 'Bearer nodex-tester-contract', 'Content-Type': 'application/json' }
beforeEach(() => {
  room = crypto.randomUUID()
  vi.stubEnv('NODEX_BETA_TOKENS', 'nodex-tester-contract')
  vi.stubEnv('NODEX_BETA_ADMIN_TOKENS', '')
  vi.stubEnv('NODEX_TENANT_ID', crypto.randomUUID())
  vi.stubEnv('NODEX_SIGNALING_SEED_TOKEN', 'service-only')
  vi.stubEnv('NODEX_BETA_STORAGE_DRIVER', '')
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', '')
  vi.stubEnv('SUPABASE_URL', '')
  vi.stubEnv('SUPABASE_SECRET_KEY', '')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
  rpc.mockReset()
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })
async function post(path: string, body: unknown, headers = tester) {
  return POST(new Request('https://local/api/signal/' + path,
    { method: 'POST', headers, body: JSON.stringify(body) }))
}
async function join(node: string) {
  const response = await post('join', { roomId: room, nodeId: node })
  expect(response.status).toBe(200)
  return await response.json() as { nodeGrant: string; peers: string[]; after: number }
}
async function poll(node: string, nodeGrant: string, after = 0) {
  const response = await GET(new Request(`https://local/api/signal/poll?roomId=${room}&nodeId=${node}&after=${after}`,
    { headers: { ...tester, 'X-Nodex-Node-Grant': nodeGrant } }))
  expect(response.status).toBe(200)
  return response.json() as Promise<{ after: number; peers: string[]; messages: Array<{ id: number; message: any }> }>
}
it('preserves concurrent joins and binds every sender to a node grant', async () => {
  const [a, b] = await Promise.all([join('node-a'), join('node-b')])
  expect((await poll('node-a', a.nodeGrant)).peers).toContain('node-b')
  expect((await post('send', { roomId: room, message: { type: 'BROADCAST', from: 'server' } })).status).toBe(403)
  const message = { type: 'OFFER', from: 'node-a', to: 'node-b', sdp: { type: 'offer', sdp: 'offer' } }
  expect((await post('send', { roomId: room, message })).status).toBe(403)
  expect((await post('send', { roomId: room, message }, { ...tester, 'X-Nodex-Node-Grant': a.nodeGrant })).status).toBe(200)
  expect((await poll('node-b', b.nodeGrant)).messages[0].message.type).toBe('OFFER')
})
it('delivers outbox seeds through the same durable contract and stable event identity', async () => {
  const a = await join('node-a')
  const eventId = crypto.randomUUID()
  const sink = createSignalingInvalidationSink({ NODEX_BETA_SIGNALING_HTTP_URL: 'https://local/api/signal',
    NODEX_SIGNALING_SEED_TOKEN: 'service-only' }, async (url, init) => POST(new Request(String(url), init)))
  const event = { tenantId: process.env['NODEX_TENANT_ID']!, eventId, resourceKey: '/api/products/1', seq: 2, updatedAt: Date.now(), attempts: 1 }
  await sink.deliver(event); await sink.deliver(event)
  const messages = (await poll('node-a', a.nodeGrant)).messages
  expect(messages).toHaveLength(1)
  expect(messages[0].message).toMatchObject({ type: 'GOSSIP_INVALIDATE', msgId: eventId, seq: 2, proof: expect.any(String) })
  expect((await post('gossip-seed', { roomId: room, key: '/api/products/1', seq: 999 })).status).toBe(401)
})
it('uses sequence cursors even for messages inserted within the same millisecond', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.now())
  const a = await join('node-a'), b = await join('node-b')
  const header = { ...tester, 'X-Nodex-Node-Grant': a.nodeGrant }
  for (let i = 0; i < 2; i++) expect((await post('send', { roomId: room,
    message: { type: 'ICE_CANDIDATE', from: 'node-a', to: 'node-b', candidate: { candidate: String(i) } } }, header)).status).toBe(200)
  const batch = await poll('node-b', b.nodeGrant)
  expect(batch.messages).toHaveLength(2)
  expect(batch.messages[1].id).toBeGreaterThan(batch.messages[0].id)
  expect((await poll('node-b', b.nodeGrant, batch.after)).messages).toHaveLength(0)
})
it('returns unavailable when the configured durable store fails, without memory fallback', async () => {
  vi.stubEnv('NODEX_BETA_STORAGE_DRIVER', 'supabase')
  vi.stubEnv('SUPABASE_URL', 'https://synthetic.invalid')
  vi.stubEnv('SUPABASE_SECRET_KEY', 'synthetic')
  rpc.mockResolvedValue({ data: null, error: { message: 'offline' } })
  expect((await post('join', { roomId: room, nodeId: 'node-a' })).status).toBe(503)
})
