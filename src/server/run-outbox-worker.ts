import { randomUUID } from 'node:crypto'
import { createSignalingInvalidationSink } from './signaling-invalidation-sink.js'
import { createSupabaseInvalidationOutbox } from './supabase-invalidation-outbox.js'
import { runOutboxBatch } from './outbox-worker.js'

const pollMs = Number(process.env['NODEX_OUTBOX_POLL_MS'] ?? 1_000)
if (!Number.isInteger(pollMs) || pollMs < 100 || pollMs > 60_000) {
  throw new TypeError('invalid NODEX_OUTBOX_POLL_MS')
}

const workerId = process.env['NODEX_OUTBOX_WORKER_ID'] ?? randomUUID()
const outbox = createSupabaseInvalidationOutbox()
const sink = createSignalingInvalidationSink()
let stopping = false

process.once('SIGINT', () => { stopping = true })
process.once('SIGTERM', () => { stopping = true })

while (!stopping) {
  try {
    const result = await runOutboxBatch(outbox, sink, { workerId })
    if (result.claimed === 0) await new Promise((resolve) => setTimeout(resolve, pollMs))
  } catch (error) {
    console.error('[Nodex Outbox] batch failed:', error)
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}
