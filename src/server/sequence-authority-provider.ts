import { SequenceAuthorityUnavailableError, type SequenceAuthority } from './sequence-authority'
import { createSupabaseSequenceAuthority } from './supabase-sequence-authority'

export type SequenceAuthorityDriver = 'supabase'

export function createSequenceAuthorityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SequenceAuthority {
  const driver = env['NODEX_SEQUENCE_DRIVER']
  if (driver === 'supabase') return createSupabaseSequenceAuthority(env)
  throw new SequenceAuthorityUnavailableError()
}

let defaultAuthority: SequenceAuthority | undefined

export function getSequenceAuthority(): SequenceAuthority {
  defaultAuthority ??= createSequenceAuthorityFromEnv()
  return defaultAuthority
}
