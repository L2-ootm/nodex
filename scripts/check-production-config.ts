import { createSequenceAuthorityFromEnv } from '../src/server/sequence-authority-provider.js'
import { configuredSessionKey } from '../src/server/session-key.js'
import { getPublisher } from '../src/server/publisher.js'
import { SEQUENCE_UUID_PATTERN } from '../src/server/sequence-authority.js'

// Read-only. Report field names; never configuration values or parser exceptions.
const failures = new Set<string>()
const requireField = (name: string, valid: boolean) => { if (!valid) failures.add(name) }
const env = process.env
requireField('NODE_ENV', env['NODE_ENV'] === 'production')
requireField('NODEX_SEQUENCE_DRIVER', env['NODEX_SEQUENCE_DRIVER'] === 'supabase')
requireField('NODEX_BETA_STORAGE_DRIVER', env['NODEX_BETA_STORAGE_DRIVER'] === 'supabase')
requireField('NODEX_TENANT_ID', SEQUENCE_UUID_PATTERN.test(env['NODEX_TENANT_ID'] ?? ''))
requireField('NODEX_PUBLISHER_EPOCH', /^[a-zA-Z0-9._-]{1,160}$/.test(env['NODEX_PUBLISHER_EPOCH'] ?? '') && env['NODEX_PUBLISHER_EPOCH'] !== 'development')
requireField('SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY', !!(env['SUPABASE_SECRET_KEY'] ?? env['SUPABASE_SERVICE_ROLE_KEY']))
for (const name of ['SUPABASE_URL','NODEX_BETA_APP_ORIGIN','NODEX_BETA_SIGNALING_HTTP_URL','NODEX_BETA_SIGNALING_URL']) {
  let valid = false
  try { const url = new URL(env[name] ?? ''); valid = url.protocol === 'https:' && !url.username && !url.password } catch {}
  requireField(name, valid)
}
requireField('NODEX_SIGNALING_SEED_TOKEN', (env['NODEX_SIGNALING_SEED_TOKEN'] ?? '').length >= 32)
requireField('NODEX_BETA_ADMIN_TOKENS', (env['NODEX_BETA_ADMIN_TOKENS'] ?? '').split(',').filter(Boolean).length > 0 &&
  (env['NODEX_BETA_ADMIN_TOKENS'] ?? '').split(',').every(value => value.trim().length >= 32))
requireField('NODEX_SESSION_KEY_HEX', /^[0-9a-f]{64}$/i.test(env['NODEX_SESSION_KEY_HEX'] ?? ''))
try { configuredSessionKey() } catch { failures.add('NODEX_SESSION_KEY_HEX') }
try { await getPublisher() } catch { failures.add('NODEX_PUBLISHER_PRIVATE_JWK') }
try { createSequenceAuthorityFromEnv() } catch { failures.add('sequence authority configuration') }
if (failures.size) {
  console.error('Invalid production fields: ' + [...failures].join(', '))
  process.exitCode = 1
} else console.log('Local production configuration is valid; database migrations, credentials and deployed routes still require live verification.')
