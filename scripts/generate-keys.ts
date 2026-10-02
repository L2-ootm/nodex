import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

const filename = process.argv[2] ?? '.env.keys.local'
const target = path.resolve(filename)
if (path.dirname(target) !== process.cwd() || !path.basename(target).startsWith('.env.') || target.endsWith('.example')) {
  throw new Error('Choose an ignored .env.* file in the project root')
}
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
const text = [
  '# Private generated credentials. Import into the API/worker secret store; never the frontend.',
  `NODEX_TENANT_ID=${randomUUID()}`,
  'NODEX_PUBLISHER_EPOCH=authority-1',
  `NODEX_PUBLISHER_PRIVATE_JWK='${JSON.stringify(privateJwk)}'`,
  `NODEX_SESSION_KEY_HEX=${randomBytes(32).toString('hex')}`,
  `NODEX_SIGNALING_SEED_TOKEN=${randomBytes(32).toString('base64url')}`,
  `NODEX_BETA_ADMIN_TOKENS=nodex-admin-${randomBytes(32).toString('base64url')}`,
].join('\n') + '\n'
await writeFile(target, text, { flag: 'wx', mode: 0o600 })
console.log('Credentials saved to ' + filename + '; existing files are never overwritten.')
