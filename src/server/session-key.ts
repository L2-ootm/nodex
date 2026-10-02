import { createHash } from 'node:crypto'

/** Key identity follows key material, so a rotated key cannot reuse a stale import. */
export function sessionKeyId(bytes: Uint8Array): string {
  return `aes-${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}`
}
export function configuredSessionKey(): { bytes: Uint8Array; keyId: string } {
  const hex = process.env['NODEX_SESSION_KEY_HEX'] ?? ''
  if (hex && !/^[0-9a-f]{64}$/i.test(hex)) throw new Error('Invalid encryption key')
  if (!hex && process.env['NODE_ENV'] === 'production') throw new Error('Encryption key unavailable')
  const bytes = hex ? new Uint8Array(Buffer.from(hex, 'hex')) : new TextEncoder().encode('nodex-dev-key-32bytes-padding!!!'.slice(0, 32))
  return { bytes, keyId: sessionKeyId(bytes) }
}
