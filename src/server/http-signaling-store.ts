import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { GossipMessage, SignalingMessage } from '../shared/types.js'

export type SignalOperation = 'join' | 'poll' | 'send' | 'leave' | 'seed'
export interface SignalCommand {
  operation: SignalOperation; tenant: string; room: string; node: string;
  owner: string; grantHash: string; after: number;
  message?: SignalingMessage | GossipMessage; eventId?: string;
}
interface NodeRecord { owner: string; grantHash: string; lastSeen: number }
interface Envelope { id: number; message: SignalingMessage | GossipMessage; createdAt: number; room: string }
interface TenantState { nodes: Map<string, NodeRecord>; messages: Envelope[]; nextId: number; events: Set<string> }
const globalState = globalThis as typeof globalThis & { __nodexAtomicSignal?: Map<string, TenantState> }
let client: SupabaseClient | undefined

/** Local commands mutate synchronously. Production executes one atomic database RPC. */
export async function executeSignal(command: SignalCommand): Promise<Record<string, unknown>> {
  const url = process.env['SUPABASE_URL']
  const secret = process.env['SUPABASE_SECRET_KEY'] ?? process.env['SUPABASE_SERVICE_ROLE_KEY']
  const driver = process.env['NODEX_BETA_STORAGE_DRIVER']
  if (driver === 'supabase' || (url && secret)) {
    if (!url || !secret) throw new Error('signal store unavailable')
    client ??= createClient(url, secret, { auth: { persistSession: false } })
    const result = await client.rpc('nodex_signal_command', {
      p_operation: command.operation, p_tenant: command.tenant, p_room: command.room,
      p_node: command.node, p_owner: command.owner, p_grant_hash: command.grantHash,
      p_after: command.after, p_message: command.message ?? null, p_event_id: command.eventId ?? null,
    })
    if (result.error || !result.data || typeof result.data !== 'object') throw new Error('signal store unavailable')
    return result.data as Record<string, unknown>
  }
  if (process.env['NODE_ENV'] === 'production' || process.env['BLOB_READ_WRITE_TOKEN']) {
    throw new Error('Atomic signaling requires Supabase in hosted mode')
  }
  const states = globalState.__nodexAtomicSignal ??= new Map<string, TenantState>()
  let state = states.get(command.tenant)
  if (!state) { state = { nodes: new Map(), messages: [], nextId: 1, events: new Set() }; states.set(command.tenant, state) }
  const now = Date.now()
  for (const [key, node] of state.nodes) if (now - node.lastSeen > 45_000) state.nodes.delete(key)
  state.messages = state.messages.filter(m => now - m.createdAt < 60_000).slice(-500)
  const nodeKey = JSON.stringify([command.room, command.node])
  const existing = state.nodes.get(nodeKey)
  const ownsNode = existing?.owner === command.owner && existing.grantHash === command.grantHash
  if (command.operation === 'join') {
    if (existing && !ownsNode) return { error: 'node already registered', status: 409 }
    state.nodes.set(nodeKey, { owner: command.owner, grantHash: command.grantHash, lastSeen: now })
  } else if (command.operation !== 'seed') {
    if (!ownsNode) return { error: 'node grant required', status: 403 }
    if (command.operation === 'leave') { state.nodes.delete(nodeKey); return { ok: true } }
    if (now - existing!.lastSeen > 15_000) existing!.lastSeen = now
  }
  if (command.operation === 'send' || command.operation === 'seed') {
    if (!command.message) return { error: 'message required', status: 400 }
    if (command.operation === 'send') {
      const target = (command.message as SignalingMessage).to
      if (!target || !state.nodes.has(JSON.stringify([command.room, target]))) return { error: 'recipient unavailable', status: 409 }
    }
    const eventId = command.eventId
    if (eventId && state.events.has(eventId)) return { ok: true, duplicate: true }
    if (eventId) { state.events.add(eventId); if (state.events.size > 2_000) state.events.delete(state.events.values().next().value!) }
    state.messages.push({ id: state.nextId++, message: command.message, room: command.room, createdAt: now })
    return { ok: true, seeded: command.operation === 'seed' }
  }
  const peers = [...state.nodes.keys()].map(key => JSON.parse(key) as string[])
    .filter(([room, node]) => room === command.room && node !== command.node).map(([, node]) => node).slice(0, 5)
  if (command.operation === 'join') return { peers, polite: peers.length > 0, after: state.nextId - 1 }
  const all = state.messages.filter(m => (m.room === command.room || m.room === '*') && m.id > command.after).slice(0, 100)
  const messages = all.filter(m => {
    const msg = m.message
    return msg.type === 'GOSSIP_INVALIDATE' || (msg.from !== command.node && (!msg.to || msg.to === command.node))
  }).map(({ id, message }) => ({ id, message }))
  return { peers, polite: peers.length > 0, messages, after: all.at(-1)?.id ?? command.after }
}
