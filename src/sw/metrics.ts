// src/sw/metrics.ts — BroadcastChannel emit + IDB buffer (D-14, D-15, D-16)
//
// D-14: BroadcastChannel('nodex-metrics') emits MetricsEvent with schema_version: 1
// D-15: nodex-metrics-buffer IDB store (max 1000 FIFO); flush on dashboard open
// D-16: source_node_id = crypto.randomUUID() generated once per SW activation, stored in IDB
//
// STRIDE mitigations:
//   T-03-02: SW validates FLUSH_BUFFER message type before executing flush (in sw.ts)
//   T-03-03: FIFO eviction at METRICS_BUFFER_MAX — oldest entry deleted before new add

/// <reference lib="webworker" />

import { getDb } from './idb.js'
import {
  METRICS_CHANNEL_NAME,
  METRICS_BUFFER_STORE,
  METRICS_BUFFER_MAX,
  META_STORE,
} from '../shared/config.js'
import type { MetricsEvent, CacheMeta } from '../shared/types.js'

declare const self: ServiceWorkerGlobalScope

// Module-level BroadcastChannel — opened once, reused on all emitMetric() calls
const channel = new BroadcastChannel(METRICS_CHANNEL_NAME)

// Module-level node ID cache — populated on first getNodeId() call
let _nodeId: string | null = null

// Internal shape stored in META_STORE under path='__node_id'.
// IDB is untyped at runtime; we cast through the CacheMeta type for the typed idb wrapper.
// The 'uuid' field carries the actual UUID value.
interface NodeIdRecord extends CacheMeta {
  uuid: string
}

// ---------------------------------------------------------------------------
// getNodeId — read or generate a persistent UUID for this SW instance (D-16)
// ---------------------------------------------------------------------------

/**
 * Return the source_node_id for this SW instance.
 * On first call: reads from IDB META_STORE (path = '__node_id').
 * If absent: generates a UUID via crypto.randomUUID(), persists it, returns it.
 * Caches in module-level _nodeId after first resolution.
 */
let nodeIdPromise: Promise<string> | null = null
export function getNodeId(): Promise<string> {
  return nodeIdPromise ??= loadNodeId().catch(error => {
    nodeIdPromise = null
    throw error
  })
}
async function loadNodeId(): Promise<string> {
  if (_nodeId) return _nodeId

  try {
    const db = await getDb()
    const record = await db.get(META_STORE, '__node_id') as NodeIdRecord | undefined
    if (record?.uuid) {
      _nodeId = record.uuid
      return _nodeId
    }
  } catch (err) {
    console.warn('[metrics] IDB node_id read failed:', err)
  }

  // Generate new UUID and persist
  const uuid = self.crypto.randomUUID()
  _nodeId = uuid

  try {
    const db = await getDb()
    const record: NodeIdRecord = {
      path: '__node_id',
      uuid,
      seq: 0,
      accessed_at: 0,
      byte_size: 0,
    }
    await db.put(META_STORE, record as unknown as CacheMeta)
  } catch (err) {
    console.warn('[metrics] IDB node_id write failed:', err)
  }

  return uuid
}

// ---------------------------------------------------------------------------
// emitMetric — build full MetricsEvent, broadcast + buffer
// ---------------------------------------------------------------------------

/**
 * Build a complete MetricsEvent, emit it on BroadcastChannel, and buffer it in IDB.
 * Called after every cache decision (sw-cache, server-fallback, peer-fetch).
 */
export async function emitMetric(partial: {
  type: MetricsEvent['type']
  key: string
  latency_ms: number
  rejection_reason?: string
  rejection_source?: 'cache' | 'peer' | 'server'
  request_id?: string
  delivered_bytes?: number
}): Promise<void> {
  const event: MetricsEvent = {
    event_id: crypto.randomUUID(),
    schema_version: 1,
    type: partial.type,
    key: partial.key,
    latency_ms: partial.latency_ms,
    source_node_id: await getNodeId(),
    timestamp: Date.now(),
    ...(partial.rejection_reason ? { rejection_reason: partial.rejection_reason } : {}),
    ...(partial.rejection_source ? { rejection_source: partial.rejection_source } : {}),
    ...(partial.request_id ? { request_id: partial.request_id } : {}),
    ...(partial.delivered_bytes === undefined ? {} : { delivered_bytes: partial.delivered_bytes }),
  }

  // Emit on BroadcastChannel (D-14)
  channel.postMessage(event)

  // Buffer in IDB (D-15)
  await bufferMetric(event)
}

// ---------------------------------------------------------------------------
// bufferMetric — FIFO write to nodex-metrics-buffer, evicting oldest on overflow
// ---------------------------------------------------------------------------

/**
 * Write a MetricsEvent to the IDB buffer store.
 * If the store has >= METRICS_BUFFER_MAX entries, delete the oldest (lowest key)
 * before inserting — FIFO eviction (T-03-03, D-15).
 */
async function bufferMetric(event: MetricsEvent): Promise<void> {
  try {
    const db = await getDb()

    const tx = db.transaction(METRICS_BUFFER_STORE, 'readwrite')
    const count = await tx.store.count()

    if (count >= METRICS_BUFFER_MAX) {
      // Open a cursor on the store — auto-increment keys are ascending, so first cursor = oldest
      const cursor = await tx.store.openCursor()
      if (cursor) {
        await cursor.delete()
      }
    }

    await tx.store.add(event)
    await tx.done
  } catch (err) {
    // IDB failure must not crash the SW or block the response
    console.warn('[metrics] bufferMetric failed:', err)
  }
}

// ---------------------------------------------------------------------------
// flushBuffer — re-emit all buffered events and clear the store
// ---------------------------------------------------------------------------

/**
 * Read all buffered MetricsEvents from IDB, re-emit each on BroadcastChannel,
 * then clear the buffer store.
 * Called when the SW receives a FLUSH_BUFFER message from the dashboard page.
 */
export async function flushBuffer(): Promise<void> {
  try {
    const db = await getDb()
    const tx = db.transaction(METRICS_BUFFER_STORE, 'readwrite')
    const buffered = await tx.store.getAll()
    await tx.store.clear()
    await tx.done

    for (const event of buffered) {
      channel.postMessage(event)
    }

    console.log(`[metrics] flushed ${buffered.length} buffered events`)
  } catch (err) {
    console.warn('[metrics] flushBuffer failed:', err)
  }
}
