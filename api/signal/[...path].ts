import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { cors } from 'hono/cors'
import { get, put } from '@vercel/blob'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { GOSSIP_TTL } from '../../src/shared/config.js'
import { validateBetaToken, unauthorizedResponse } from '../lib/auth.js'
import type { GossipMessage, SignalingMessage } from '../../src/shared/types.js'

export const config = { runtime: 'nodejs' }

interface SignalEnvelope {
  id: number
  createdAt: number
  message: SignalingMessage | GossipMessage
}

interface SignalNode {
  lastSeen: number
}

interface SignalRoomState {
  nextId: number
  nodes: Record<string, SignalNode>
  messages: SignalEnvelope[]
}

const NODE_TTL_MS = 45_000
const MESSAGE_TTL_MS = 60_000
const MAX_MESSAGES = 500
const SIGNAL_LOG_MARKER = '__nodex_signal_state__'
// Each signal message is a separate row to prevent concurrent-write data loss.
const SIGNAL_MSG_MARKER = '__nodex_signal_msg__'
const globalSignalState = globalThis as typeof globalThis & {
  __nodexSignalRooms?: Map<string, SignalRoomState>
  __nodexSignalSupabase?: SupabaseClient
}

function memoryRooms(): Map<string, SignalRoomState> {
  globalSignalState.__nodexSignalRooms ??= new Map<string, SignalRoomState>()
  return globalSignalState.__nodexSignalRooms
}

function cloneState(state: SignalRoomState): SignalRoomState {
  return {
    nextId: state.nextId,
    nodes: Object.fromEntries(Object.entries(state.nodes).map(([nodeId, node]) => [nodeId, { ...node }])),
    messages: state.messages.map((message) => ({ ...message, message: { ...message.message } })),
  }
}

function safeRoomId(roomId: string): string {
  return roomId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'default'
}

function blobKey(roomId: string): string {
  return `nodex-signal/${safeRoomId(roomId)}.json`
}

function emptyState(): SignalRoomState {
  return { nextId: 1, nodes: {}, messages: [] }
}

function shouldUseSupabaseState(): boolean {
  const hasSupabase =
    Boolean(process.env['SUPABASE_URL']) &&
    Boolean(process.env['SUPABASE_SECRET_KEY'] ?? process.env['SUPABASE_SERVICE_ROLE_KEY'])
  return process.env['NODEX_BETA_STORAGE_DRIVER'] === 'supabase' || (hasSupabase && !process.env['BLOB_READ_WRITE_TOKEN'])
}

function supabaseClient(): SupabaseClient | null {
  if (!shouldUseSupabaseState()) return null
  globalSignalState.__nodexSignalSupabase ??= createClient(
    process.env['SUPABASE_URL'] ?? '',
    process.env['SUPABASE_SECRET_KEY'] ?? process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
    {
      auth: { persistSession: false },
    }
  )
  return globalSignalState.__nodexSignalSupabase
}

function normalizeState(state: SignalRoomState): SignalRoomState {
  return {
    nextId: Number.isInteger(state.nextId) && state.nextId > 0 ? state.nextId : 1,
    nodes: state.nodes && typeof state.nodes === 'object' ? state.nodes : {},
    messages: Array.isArray(state.messages) ? state.messages : [],
  }
}

async function readSupabaseState(roomId: string): Promise<SignalRoomState | null> {
  const client = supabaseClient()
  if (!client) return null

  try {
    const selected = await client
      .from('beta_logs')
      .select('details')
      .eq('room_id', roomId)
      .eq('message', SIGNAL_LOG_MARKER)
      .order('created_at', { ascending: false })
      .limit(1)

    if (selected.error) throw new Error(selected.error.message)
    const state = (selected.data?.[0]?.['details'] as { state?: SignalRoomState } | undefined)?.state
    return state ? normalizeState(state) : emptyState()
  } catch (err) {
    console.warn('[signal] Supabase state read failed; using in-memory fallback', err)
    const fallback = memoryRooms().get(safeRoomId(roomId))
    return fallback ? cloneState(fallback) : emptyState()
  }
}

async function writeSupabaseState(roomId: string, state: SignalRoomState): Promise<void> {
  const client = supabaseClient()
  if (!client) return

  try {
    await client
      .from('beta_logs')
      .insert({
        log_id: `signal-${crypto.randomUUID()}`,
        room_id: roomId,
        token_role: 'admin',
        level: 'info',
        message: SIGNAL_LOG_MARKER,
        details: { state },
      })
      .throwOnError()
  } catch (err) {
    console.warn('[signal] Supabase state write failed; using in-memory fallback', err)
  }
}

// Insert a single signal message as an individual Supabase row.
// This replaces append-into-state-blob to eliminate concurrent-write data loss.
async function writeMessageToSupabase(roomId: string, id: number, message: SignalingMessage | GossipMessage): Promise<void> {
  const client = supabaseClient()
  if (!client) return
  try {
    await client
      .from('beta_logs')
      .insert({
        log_id: `signal-msg-${id}-${crypto.randomUUID()}`,
        room_id: roomId,
        token_role: 'admin',
        level: 'info',
        message: SIGNAL_MSG_MARKER,
        details: { id, message },
      })
      .throwOnError()
  } catch (err) {
    console.warn('[signal] Supabase message write failed', err)
  }
}

// Read signal messages inserted after `afterMs` (ms since epoch).
async function readMessagesFromSupabase(roomId: string, afterMs: number): Promise<SignalEnvelope[]> {
  const client = supabaseClient()
  if (!client) return []
  try {
    const cutoff = new Date(Math.max(afterMs, Date.now() - MESSAGE_TTL_MS)).toISOString()
    const { data, error } = await client
      .from('beta_logs')
      .select('details, created_at')
      .eq('room_id', roomId)
      .eq('message', SIGNAL_MSG_MARKER)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(MAX_MESSAGES)
    if (error) throw new Error(error.message)
    return (data ?? []).map((row) => {
      const d = row['details'] as { id?: number; message?: unknown } | undefined
      const ts = new Date(row['created_at'] as string).getTime()
      return {
        id: typeof d?.id === 'number' ? d.id : ts,
        createdAt: ts,
        message: d?.message as SignalingMessage | GossipMessage,
      }
    }).filter((e) => e.message && e.id > afterMs)
  } catch (err) {
    console.warn('[signal] Supabase message read failed', err)
    return []
  }
}

async function readState(roomId: string): Promise<SignalRoomState> {
  const fallback = memoryRooms().get(safeRoomId(roomId))
  const supabaseState = await readSupabaseState(roomId)
  if (supabaseState) return supabaseState
  if (!process.env['BLOB_READ_WRITE_TOKEN']) {
    // In-memory fallback: state is per-instance and will not persist across Vercel cold starts.
    // Set SUPABASE_URL+SUPABASE_SECRET_KEY or BLOB_READ_WRITE_TOKEN to enable durable signaling.
    if (process.env['VERCEL'] === '1' || process.env['VERCEL_ENV']) {
      console.warn('[signal] WARNING: No durable storage configured (SUPABASE_URL or BLOB_READ_WRITE_TOKEN missing). Signaling state is in-memory and will not work across Vercel instances.')
    }
    return fallback ? cloneState(fallback) : emptyState()
  }
  try {
    const blob = await get(blobKey(roomId), { access: 'private', useCache: false })
    if (!blob?.stream) return emptyState()
    const state = JSON.parse(await new Response(blob.stream).text()) as SignalRoomState
    return normalizeState(state)
  } catch {
    return fallback ? cloneState(fallback) : emptyState()
  }
}

async function writeState(roomId: string, state: SignalRoomState): Promise<void> {
  const now = Date.now()
  const nodes = Object.fromEntries(
    Object.entries(state.nodes).filter(([, node]) => now - node.lastSeen <= NODE_TTL_MS)
  )
  const messages = state.messages
    .filter((message) => now - message.createdAt <= MESSAGE_TTL_MS)
    .slice(-MAX_MESSAGES)
  const compacted = { ...state, nodes, messages }

  memoryRooms().set(safeRoomId(roomId), cloneState(compacted))
  await writeSupabaseState(roomId, compacted)
  if (!process.env['BLOB_READ_WRITE_TOKEN']) return
  try {
    await put(blobKey(roomId), JSON.stringify(compacted), {
      access: 'private',
      allowOverwrite: true,
      contentType: 'application/json',
    })
  } catch (err) {
    console.warn('[signal] Blob state write failed; using in-memory fallback', err)
  }
}

function activeNodeIds(state: SignalRoomState, excludeNodeId: string): string[] {
  const now = Date.now()
  return Object.entries(state.nodes)
    .filter(([nodeId, node]) => nodeId !== excludeNodeId && now - node.lastSeen <= NODE_TTL_MS)
    .map(([nodeId]) => nodeId)
}

function appendMessage(state: SignalRoomState, message: SignalingMessage | GossipMessage): void {
  state.messages.push({
    id: state.nextId++,
    createdAt: Date.now(),
    message,
  })
}

function envelopeSender(message: SignalingMessage | GossipMessage): string | undefined {
  return message.type === 'GOSSIP_INVALIDATE' ? message.originNodeId : message.from
}

function envelopeTarget(message: SignalingMessage | GossipMessage): string | undefined {
  return message.type === 'GOSSIP_INVALIDATE' ? undefined : message.to
}

const app = new Hono()
app.use('*', cors({ origin: '*' }))

app.post('/api/signal/join', async (c) => {
  if (!validateBetaToken(c.req.raw, 'tester')) {
    return c.newResponse(unauthorizedResponse().body, 401, { 'Content-Type': 'application/json' })
  }
  const body = await c.req.json().catch(() => null) as { roomId?: string; nodeId?: string } | null
  const roomId = body?.roomId?.trim()
  const nodeId = body?.nodeId?.trim()
  if (!roomId || !nodeId) return c.json({ error: 'roomId and nodeId required' }, 400)

  const state = await readState(roomId)
  const peers = activeNodeIds(state, nodeId).slice(-5)
  state.nodes[nodeId] = { lastSeen: Date.now() }
  await writeState(roomId, state)
  // Return epoch ms as the cursor; Supabase messages are filtered by created_at >= cursor.
  // In-memory fallback uses integer IDs which start at 0, so after=0 returns all messages.
  const after = shouldUseSupabaseState() ? Date.now() : state.nextId - 1

  return c.json({ peers, polite: peers.length > 0, after })
})

app.post('/api/signal/send', async (c) => {
  if (!validateBetaToken(c.req.raw, 'tester')) {
    return c.newResponse(unauthorizedResponse().body, 401, { 'Content-Type': 'application/json' })
  }
  const body = await c.req.json().catch(() => null) as { roomId?: string; message?: SignalingMessage } | null
  const roomId = body?.roomId?.trim()
  const message = body?.message
  if (!roomId || !message?.type || !message.from) return c.json({ error: 'roomId and message required' }, 400)

  const state = await readState(roomId)
  state.nodes[message.from] = { lastSeen: Date.now() }

  if (shouldUseSupabaseState()) {
    // Write each message as an individual row to avoid concurrent-write data loss.
    const msgId = Date.now()
    await writeMessageToSupabase(roomId, msgId, message)
    // State blob stores node presence only (no messages).
    await writeState(roomId, state)
  } else {
    appendMessage(state, message)
    await writeState(roomId, state)
  }

  return c.json({ ok: true })
})

app.get('/api/signal/poll', async (c) => {
  if (!validateBetaToken(c.req.raw, 'tester')) {
    return c.newResponse(unauthorizedResponse().body, 401, { 'Content-Type': 'application/json' })
  }
  const roomId = c.req.query('roomId')?.trim()
  const nodeId = c.req.query('nodeId')?.trim()
  const after = Number(c.req.query('after') ?? '0')
  if (!roomId || !nodeId) return c.json({ error: 'roomId and nodeId required' }, 400)

  const state = await readState(roomId)
  state.nodes[nodeId] = { lastSeen: Date.now() }
  const peers = activeNodeIds(state, nodeId).slice(-5)

  let messages: SignalEnvelope[]
  if (shouldUseSupabaseState()) {
    // Read individual message rows — no write race with concurrent /send calls.
    const allMsgs = await readMessagesFromSupabase(roomId, after)
    messages = allMsgs.filter((envelope) => {
      const msg = envelope.message
      const from = envelopeSender(msg)
      const to = envelopeTarget(msg)
      if (from === nodeId) return false
      return !to || to === nodeId
    })
  } else {
    // In-memory / Blob fallback: messages live in the compact room state.
    messages = state.messages.filter((envelope) => {
      if (Number.isFinite(after) && envelope.id <= after) return false
      const msg = envelope.message
      const from = envelopeSender(msg)
      const to = envelopeTarget(msg)
      if (from === nodeId) return false
      return !to || to === nodeId
    })
  }
  await writeState(roomId, state)

  return c.json({ messages, peers, polite: peers.length > 0 })
})

app.post('/api/signal/leave', async (c) => {
  if (!validateBetaToken(c.req.raw, 'tester')) {
    return c.newResponse(unauthorizedResponse().body, 401, { 'Content-Type': 'application/json' })
  }
  const body = await c.req.json().catch(() => null) as { roomId?: string; nodeId?: string } | null
  const roomId = body?.roomId?.trim()
  const nodeId = body?.nodeId?.trim()
  if (!roomId || !nodeId) return c.json({ error: 'roomId and nodeId required' }, 400)

  const state = await readState(roomId)
  delete state.nodes[nodeId]
  await writeState(roomId, state)

  return c.json({ ok: true })
})

app.post('/api/signal/gossip-seed', async (c) => {
  if (!validateBetaToken(c.req.raw, 'tester')) {
    return c.newResponse(unauthorizedResponse().body, 401, {
      'Content-Type': 'application/json',
    })
  }
  const body = await c.req.json().catch(() => null) as { roomId?: string; key?: string; seq?: number; originNodeId?: string } | null
  const roomId = body?.roomId?.trim() || c.req.query('roomId')?.trim()
  if (!roomId || !body?.key || typeof body.seq !== 'number') return c.json({ error: 'roomId, key, and seq required' }, 400)

  const state = await readState(roomId)
  appendMessage(state, {
    type: 'GOSSIP_INVALIDATE',
    msgId: crypto.randomUUID(),
    key: body.key,
    seq: body.seq,
    ttl: GOSSIP_TTL,
    originNodeId: body.originNodeId ?? 'server',
    t_invalidate: Date.now(),
  })
  await writeState(roomId, state)

  return c.json({ seeded: true })
})

const handler = handle(app)
export const GET = handler
export const POST = handler
export const OPTIONS = handler
