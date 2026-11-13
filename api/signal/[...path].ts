import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { handle } from 'hono/vercel'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import { GOSSIP_TTL } from '../../src/shared/config.js'
import { validateBetaToken, unauthorizedResponse } from '../lib/auth.js'
import { rateLimited } from '../lib/rate-limit.js'
import { executeSignal, type SignalCommand } from '../../src/server/http-signaling-store.js'
import { publishProof } from '../../src/server/publisher.js'
import { getSequenceAuthority } from '../../src/server/sequence-authority-provider.js'
import type { SignalingMessage } from '../../src/shared/types.js'

export const config = { runtime: 'nodejs' }
export const app = new Hono()
app.use('*', cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization', 'X-Nodex-Node-Grant'] }))
app.use('*', bodyLimit({ maxSize: 128 * 1024 }))
// Per credential per minute. Steady-state polling is about 4/min and discovery bursts at 1/s for 20 s.
app.use('/api/signal/join', rateLimited(30))
app.use('/api/signal/leave', rateLimited(30))
app.use('/api/signal/send', rateLimited(120))
app.use('/api/signal/poll', rateLimited(180))
app.onError((_error, c) => c.json({ error: 'signaling unavailable' }, 503))
function id(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{1,160}$/.test(value) && value !== 'server' ? value : null
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function owner(req: Request): string { return hash(req.headers.get('Authorization') ?? '') }
function tenant(): string { return process.env['NODEX_TENANT_ID'] ?? 'default' }
function grant(req: Request): string { return req.headers.get('X-Nodex-Node-Grant') ?? '' }
function serviceAuthorized(req: Request): boolean {
  const token = process.env['NODEX_SIGNALING_SEED_TOKEN']
  const provided = req.headers.get('Authorization')?.replace(/^Bearer /, '') ?? ''
  return !!token && !!provided && timingSafeEqual(Buffer.from(hash(token), 'hex'), Buffer.from(hash(provided), 'hex'))
}
async function command(input: SignalCommand, c: Context) {
  const result = await executeSignal(input)
  const status = result.status === 400 ? 400 : result.status === 403 ? 403 : result.status === 409 ? 409 : 200
  return c.json(result, status)
}
app.post('/api/signal/join', async c => {
  if (!await validateBetaToken(c.req.raw, 'tester')) return c.newResponse(unauthorizedResponse().body, 401)
  const body = await c.req.json().catch(() => null)
  const room = id(body?.roomId), node = id(body?.nodeId)
  if (!room || !node) return c.json({ error: 'roomId and nodeId required' }, 400)
  const nodeGrant = grant(c.req.raw) || crypto.randomUUID() + crypto.randomUUID()
  const result = await executeSignal({ operation: 'join', tenant: tenant(), room, node,
    owner: owner(c.req.raw), grantHash: hash(nodeGrant), after: 0 })
  if (result.error) return c.json(result, result.status as 409)
  return c.json({ ...result, nodeGrant })
})
app.post('/api/signal/send', async c => {
  if (!await validateBetaToken(c.req.raw, 'tester')) return c.newResponse(unauthorizedResponse().body, 401)
  const body = await c.req.json().catch(() => null)
  const room = id(body?.roomId)
  const message = body?.message as SignalingMessage | undefined
  const node = id(message?.from), to = id(message?.to)
  if (!room || !message || !node || !to) return c.json({ error: 'registered sender and recipient required' }, 403)
  if (!['OFFER', 'ANSWER', 'ICE_CANDIDATE'].includes(message.type)) return c.json({ error: 'message type forbidden' }, 403)
  if (message.type !== 'ICE_CANDIDATE' && (typeof message.sdp?.sdp !== 'string' ||
    message.sdp.sdp.length > 64 * 1024 || message.sdp.type !== (message.type === 'OFFER' ? 'offer' : 'answer'))) {
    return c.json({ error: 'invalid SDP' }, 400)
  }
  if (message.type === 'ICE_CANDIDATE' && typeof message.candidate?.candidate !== 'string') return c.json({ error: 'invalid candidate' }, 400)
  return command({ operation: 'send', tenant: tenant(), room, node, owner: owner(c.req.raw),
    grantHash: hash(grant(c.req.raw)), after: 0, message }, c)
})
app.get('/api/signal/poll', async c => {
  if (!await validateBetaToken(c.req.raw, 'tester')) return c.newResponse(unauthorizedResponse().body, 401)
  const room = id(c.req.query('roomId')), node = id(c.req.query('nodeId'))
  const after = Number(c.req.query('after') ?? 0)
  if (!room || !node || !Number.isSafeInteger(after) || after < 0) return c.json({ error: 'invalid poll cursor or node' }, 400)
  return command({ operation: 'poll', tenant: tenant(), room, node, owner: owner(c.req.raw),
    grantHash: hash(grant(c.req.raw)), after }, c)
})
app.post('/api/signal/leave', async c => {
  if (!await validateBetaToken(c.req.raw, 'tester')) return c.newResponse(unauthorizedResponse().body, 401)
  const body = await c.req.json().catch(() => null)
  const room = id(body?.roomId), node = id(body?.nodeId)
  if (!room || !node) return c.json({ error: 'roomId and nodeId required' }, 400)
  return command({ operation: 'leave', tenant: tenant(), room, node, owner: owner(c.req.raw),
    grantHash: hash(grant(c.req.raw)), after: 0 }, c)
})
app.post('/api/signal/gossip-seed', async c => {
  if (!serviceAuthorized(c.req.raw)) return c.json({ error: 'publisher service credential required' }, 401)
  const body = await c.req.json().catch(() => null)
  if (!body || body.tenantId !== tenant() || typeof body.key !== 'string' ||
    !/^\/api\/products\/[a-zA-Z0-9_-]{1,200}$/.test(body.key) || !Number.isSafeInteger(body.seq) || body.seq < 1 ||
    typeof body.eventId !== 'string' || body.eventId.length > 160 || !body.eventId) return c.json({ error: 'invalid publication' }, 400)
  const room = body.roomId === undefined ? '*' : id(body.roomId)
  if (!room) return c.json({ error: 'invalid room' }, 400)
  // The seed credential delivers committed events; it cannot mint an arbitrary
  // future version that would permanently poison readers' durable barriers.
  if (process.env['NODE_ENV'] === 'production') {
    const head = await getSequenceAuthority().read(body.key)
    if (body.seq > head.seq) return c.json({ error: 'publication exceeds authoritative version' }, 409)
  }
  const validatedAt = Date.now()
  const proof = await publishProof({ kind: 'invalidation', resource: body.key, version: body.seq, validatedAt })
  return command({ operation: 'seed', tenant: tenant(), room, node: 'server', owner: 'publisher',
    grantHash: '', after: 0, eventId: body.eventId, message: { type: 'GOSSIP_INVALIDATE', key: body.key,
      seq: body.seq, msgId: body.eventId, originNodeId: 'server', ttl: GOSSIP_TTL, t_invalidate: validatedAt, proof } }, c)
})
const handler = handle(app)
export const GET = handler
export const POST = handler
export const OPTIONS = handler
