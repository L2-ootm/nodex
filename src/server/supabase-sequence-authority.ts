import { createClient } from '@supabase/supabase-js'
import {
  assertSequenceResourceKey,
  assertSequenceUuid,
  MAX_SAFE_SEQUENCE,
  SequenceAuthorityInputError,
  SequenceAuthorityUnavailableError,
  type SequenceAuthority,
  type SequenceBump,
  type SequenceRecord,
} from './sequence-authority'

interface RpcError {
  message?: string
}

export interface SequenceRpcClient {
  rpc(name: string, params: Record<string, unknown>): PromiseLike<{
    data: unknown
    error: RpcError | null
  }>
}

function singleRow(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) throw new SequenceAuthorityUnavailableError()
  const row = value[0]
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new SequenceAuthorityUnavailableError()
  return row as Record<string, unknown>
}

function parseSequence(value: unknown): number | null {
  const seq = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return Number.isSafeInteger(seq) && (seq as number) >= 1 && (seq as number) <= MAX_SAFE_SEQUENCE
    ? seq as number
    : null
}

function parseUpdatedAt(value: unknown): number | null {
  if (typeof value !== 'string' || !/(?:Z|\+00:00)$/.test(value)) return null
  const timestamp = Date.parse(value)
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null
}

function parseRecord(row: Record<string, unknown>): SequenceRecord {
  const seq = parseSequence(row['seq'])
  const updatedAt = parseUpdatedAt(row['updated_at'])
  if (seq === null || updatedAt === null) throw new SequenceAuthorityUnavailableError()
  return { seq, updatedAt }
}

export class SupabaseSequenceAuthority implements SequenceAuthority {
  constructor(
    private readonly client: SequenceRpcClient,
    private readonly tenantId: string,
  ) {
    assertSequenceUuid(tenantId)
  }

  async read(resourceKey: string): Promise<SequenceRecord> {
    assertSequenceResourceKey(resourceKey)
    try {
      const { data, error } = await this.client.rpc('nodex_read_sequence', {
        p_tenant_id: this.tenantId,
        p_resource_key: resourceKey,
      })
      if (error) throw new SequenceAuthorityUnavailableError()
      return parseRecord(singleRow(data))
    } catch (error) {
      if (error instanceof SequenceAuthorityInputError) throw error
      throw new SequenceAuthorityUnavailableError()
    }
  }

  async bump(resourceKey: string, idempotencyKey: string): Promise<SequenceBump> {
    assertSequenceResourceKey(resourceKey)
    assertSequenceUuid(idempotencyKey)
    try {
      const { data, error } = await this.client.rpc('nodex_bump_sequence', {
        p_tenant_id: this.tenantId,
        p_resource_key: resourceKey,
        p_idempotency_key: idempotencyKey,
      })
      if (error) throw new SequenceAuthorityUnavailableError()
      const row = singleRow(data)
      const record = parseRecord(row)
      const eventId = row['event_id']
      const duplicate = row['duplicate']
      if (typeof eventId !== 'string' || typeof duplicate !== 'boolean') {
        throw new SequenceAuthorityUnavailableError()
      }
      assertSequenceUuid(eventId)
      return { ...record, eventId, duplicate }
    } catch (error) {
      if (error instanceof SequenceAuthorityInputError) throw error
      throw new SequenceAuthorityUnavailableError()
    }
  }
}

export function createSupabaseSequenceAuthority(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseSequenceAuthority {
  const url = env['SUPABASE_URL']
  const secretKey = env['SUPABASE_SECRET_KEY'] ?? env['SUPABASE_SERVICE_ROLE_KEY']
  const tenantId = env['NODEX_TENANT_ID']
  if (!url || !secretKey || !tenantId) throw new SequenceAuthorityUnavailableError()
  const client = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as SequenceRpcClient
  return new SupabaseSequenceAuthority(client, tenantId)
}
