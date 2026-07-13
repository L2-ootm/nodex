import { SequenceAuthorityUnavailableError, type SequenceAuthority } from './sequence-authority'
import { InMemorySequenceAuthority } from './in-memory-sequence-authority'
import { createSupabaseSequenceAuthority } from './supabase-sequence-authority'

export type SequenceAuthorityDriver = 'supabase' | 'memory'

export function createSequenceAuthorityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SequenceAuthority {
  const driver = env['NODEX_SEQUENCE_DRIVER']
  if (driver === 'supabase') return createSupabaseSequenceAuthority(env)
  if (driver === 'memory' && env['NODE_ENV'] !== 'production') {
    const tenantId = env['NODEX_TENANT_ID']
    if (!tenantId) throw new SequenceAuthorityUnavailableError()
    return new InMemorySequenceAuthority(tenantId)
  }
  throw new SequenceAuthorityUnavailableError()
}

let defaultAuthority: SequenceAuthority | undefined

export function getSequenceAuthority(): SequenceAuthority {
  defaultAuthority ??= createSequenceAuthorityFromEnv()
  return defaultAuthority
}
