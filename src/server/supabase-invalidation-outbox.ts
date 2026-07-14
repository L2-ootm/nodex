import { createClient } from '@supabase/supabase-js'
import {
  assertInvalidationEvent,
  assertOutboxClaim,
  assertOutboxRetry,
  assertOutboxWorkerId,
  InvalidationOutboxInputError,
  InvalidationOutboxUnavailableError,
  type InvalidationEvent,
  type InvalidationOutbox,
} from './invalidation-outbox.js'
import { assertSequenceUuid } from './sequence-authority.js'

interface RpcError {
  message?: string
}

export interface OutboxRpcClient {
  rpc(name: string, params: Record<string, unknown>): PromiseLike<{
    data: unknown
    error: RpcError | null
  }>
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/(?:Z|\+00:00)$/.test(value)) return null
  const timestamp = Date.parse(value)
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null
}

function parseInteger(value: unknown): number | null {
  const integer = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return Number.isSafeInteger(integer) ? integer as number : null
}

function parseEvent(value: unknown, tenantId: string): InvalidationEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidationOutboxUnavailableError()
  }
  const row = value as Record<string, unknown>
  const event: InvalidationEvent = {
    tenantId,
    eventId: typeof row['event_id'] === 'string' ? row['event_id'] : '',
    resourceKey: typeof row['resource_key'] === 'string' ? row['resource_key'] : '',
    seq: parseInteger(row['seq']) ?? 0,
    updatedAt: parseTimestamp(row['sequence_updated_at']) ?? 0,
    attempts: parseInteger(row['attempts']) ?? -1,
  }
  assertInvalidationEvent(event)
  return event
}

function parseMutationResult(value: unknown, field: 'acknowledged' | 'retried'): boolean {
  if (!Array.isArray(value) || value.length !== 1) throw new InvalidationOutboxUnavailableError()
  const row = value[0]
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new InvalidationOutboxUnavailableError()
  const result = (row as Record<string, unknown>)[field]
  if (typeof result !== 'boolean') throw new InvalidationOutboxUnavailableError()
  return result
}

export class SupabaseInvalidationOutbox implements InvalidationOutbox {
  constructor(
    private readonly client: OutboxRpcClient,
    private readonly tenantId: string,
  ) {
    try {
      assertSequenceUuid(tenantId)
    } catch {
      throw new InvalidationOutboxInputError()
    }
  }

  async claim(workerId: string, limit: number, leaseMs: number): Promise<InvalidationEvent[]> {
    assertOutboxWorkerId(workerId)
    assertOutboxClaim(limit, leaseMs)
    try {
      const { data, error } = await this.client.rpc('nodex_claim_sequence_outbox', {
        p_tenant_id: this.tenantId,
        p_worker_id: workerId,
        p_limit: limit,
        p_lease_seconds: leaseMs / 1_000,
      })
      if (error || !Array.isArray(data)) throw new InvalidationOutboxUnavailableError()
      return data.map((row) => parseEvent(row, this.tenantId))
    } catch (error) {
      if (error instanceof InvalidationOutboxInputError) throw error
      throw new InvalidationOutboxUnavailableError()
    }
  }

  async acknowledge(eventId: string, workerId: string): Promise<boolean> {
    this.assertMutationIds(eventId, workerId)
    try {
      const { data, error } = await this.client.rpc('nodex_ack_sequence_outbox', {
        p_tenant_id: this.tenantId,
        p_event_id: eventId,
        p_worker_id: workerId,
      })
      if (error) throw new InvalidationOutboxUnavailableError()
      return parseMutationResult(data, 'acknowledged')
    } catch (error) {
      if (error instanceof InvalidationOutboxInputError) throw error
      throw new InvalidationOutboxUnavailableError()
    }
  }

  async retry(eventId: string, workerId: string, delayMs: number, error: string): Promise<boolean> {
    this.assertMutationIds(eventId, workerId)
    assertOutboxRetry(delayMs, error)
    try {
      const result = await this.client.rpc('nodex_retry_sequence_outbox', {
        p_tenant_id: this.tenantId,
        p_event_id: eventId,
        p_worker_id: workerId,
        p_delay_ms: delayMs,
        p_error: error,
      })
      if (result.error) throw new InvalidationOutboxUnavailableError()
      return parseMutationResult(result.data, 'retried')
    } catch (caught) {
      if (caught instanceof InvalidationOutboxInputError) throw caught
      throw new InvalidationOutboxUnavailableError()
    }
  }

  private assertMutationIds(eventId: string, workerId: string): void {
    try {
      assertSequenceUuid(eventId)
      assertOutboxWorkerId(workerId)
    } catch {
      throw new InvalidationOutboxInputError()
    }
  }
}

export function createSupabaseInvalidationOutbox(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseInvalidationOutbox {
  const url = env['SUPABASE_URL']
  const secretKey = env['SUPABASE_SECRET_KEY'] ?? env['SUPABASE_SERVICE_ROLE_KEY']
  const tenantId = env['NODEX_TENANT_ID']
  if (!url || !secretKey || !tenantId) throw new InvalidationOutboxUnavailableError()
  const client = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as OutboxRpcClient
  return new SupabaseInvalidationOutbox(client, tenantId)
}
