import { createClient } from '@supabase/supabase-js'

const MAX_SAFE_SEQUENCE = Number.MAX_SAFE_INTEGER
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface SequenceRecord {
  seq: number
  updatedAt: number
}

export interface SequenceBump extends SequenceRecord {
  eventId: string
  duplicate: boolean
}

export interface SequenceAuthority {
  read(resourceKey: string): Promise<SequenceRecord>
  bump(resourceKey: string, idempotencyKey: string): Promise<SequenceBump>
}

interface RpcError {
  message?: string
}

export interface SequenceRpcClient {
  rpc(name: string, params: Record<string, unknown>): PromiseLike<{
    data: unknown
    error: RpcError | null
  }>
}

export class SequenceAuthorityUnavailableError extends Error {
  constructor() {
    super('sequence authority unavailable')
    this.name = 'SequenceAuthorityUnavailableError'
  }
}

export class SequenceAuthorityInputError extends Error {
  constructor() {
    super('invalid sequence authority input')
    this.name = 'SequenceAuthorityInputError'
  }
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
  return Number.isSafeInteger(timestamp) && timestamp > 0
    ? timestamp
    : null
}

function parseRecord(row: Record<string, unknown>): SequenceRecord {
  const seq = parseSequence(row['seq'])
  const updatedAt = parseUpdatedAt(row['updated_at'])
  if (seq === null || updatedAt === null) throw new SequenceAuthorityUnavailableError()
  return { seq, updatedAt }
}

function assertResourceKey(resourceKey: string): void {
  if (
    !resourceKey.startsWith('/api/') ||
    resourceKey.length > 2048 ||
    resourceKey.includes('//') ||
    /[\\?#\u0000-\u001f\u007f]/.test(resourceKey)
  ) {
    throw new SequenceAuthorityInputError()
  }
}

export class SupabaseSequenceAuthority {
  constructor(
    private readonly client: SequenceRpcClient,
    private readonly tenantId: string,
  ) {
    if (!UUID_PATTERN.test(tenantId)) throw new SequenceAuthorityInputError()
  }

  async read(resourceKey: string): Promise<SequenceRecord> {
    assertResourceKey(resourceKey)
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
    assertResourceKey(resourceKey)
    if (!UUID_PATTERN.test(idempotencyKey)) throw new SequenceAuthorityInputError()
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
      if (typeof eventId !== 'string' || !UUID_PATTERN.test(eventId) || typeof duplicate !== 'boolean') {
        throw new SequenceAuthorityUnavailableError()
      }
      return { ...record, eventId, duplicate }
    } catch (error) {
      if (error instanceof SequenceAuthorityInputError) throw error
      throw new SequenceAuthorityUnavailableError()
    }
  }
}

export function createSequenceAuthorityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseSequenceAuthority {
  const url = env['SUPABASE_URL']
  const serviceRoleKey = env['SUPABASE_SECRET_KEY'] ?? env['SUPABASE_SERVICE_ROLE_KEY']
  const tenantId = env['NODEX_TENANT_ID']
  if (!url || !serviceRoleKey || !tenantId) throw new SequenceAuthorityUnavailableError()
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as SequenceRpcClient
  return new SupabaseSequenceAuthority(client, tenantId)
}

let defaultAuthority: SupabaseSequenceAuthority | undefined

export function getSequenceAuthority(): SupabaseSequenceAuthority {
  defaultAuthority ??= createSequenceAuthorityFromEnv()
  return defaultAuthority
}
