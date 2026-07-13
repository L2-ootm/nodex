import { describe, expect, it } from 'vitest'
import { SequenceAuthorityUnavailableError } from './sequence-authority.js'
import { createSequenceAuthorityFromEnv } from './sequence-authority-provider.js'
import { SupabaseSequenceAuthority } from './supabase-sequence-authority.js'

const configuredEnv = {
  NODEX_SEQUENCE_DRIVER: 'supabase',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'secret-key',
  NODEX_TENANT_ID: '018f5b79-24c1-7a63-abfd-46a8c5ae23e7',
}

describe('sequence authority provider', () => {
  it('selects the configured adapter behind the universal contract', () => {
    expect(createSequenceAuthorityFromEnv(configuredEnv)).toBeInstanceOf(SupabaseSequenceAuthority)
  })

  it('fails closed for absent or unsupported drivers', () => {
    expect(() => createSequenceAuthorityFromEnv({})).toThrow(SequenceAuthorityUnavailableError)
    expect(() => createSequenceAuthorityFromEnv({
      ...configuredEnv,
      NODEX_SEQUENCE_DRIVER: 'unknown',
    })).toThrow(SequenceAuthorityUnavailableError)
  })
})
