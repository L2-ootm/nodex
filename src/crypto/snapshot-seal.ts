import { buildPayloadAad } from './crypto.js'

/**
 * Deterministic AES-GCM sealing of one public snapshot.
 *
 * The IV is an HMAC over key identity, epoch, resource, version AND the plaintext hash, under an
 * HKDF subkey (never the raw AES key). The same (resource, version, plaintext) always yields the
 * same ciphertext, so origin can re-sign bytes a peer already holds. If a payload ever changes at
 * the same (resource, version) (reset, epoch rollover, a write that did not bump the version),
 * the plaintext hash changes the IV, so it is a fresh nonce and never an AES-GCM nonce reuse.
 */
function bytes(value: Uint8Array): ArrayBuffer { return Uint8Array.from(value).buffer }
function hex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), b => b.toString(16).padStart(2, '0')).join('')
}

export async function sealSnapshot(input: {
  keyBytes: Uint8Array; keyId: string; epoch: string; path: string; seq: number; plaintext: string
}): Promise<{ ciphertext: string; iv: string }> {
  const subtle = globalThis.crypto.subtle
  const encoder = new TextEncoder()
  const plain = encoder.encode(input.plaintext)
  const ikm = await subtle.importKey('raw', bytes(input.keyBytes), 'HKDF', false, ['deriveKey'])
  const ivKey = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: bytes(encoder.encode('nodex-iv-v3')), info: bytes(encoder.encode(input.keyId)) },
    ikm, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const plainHash = hex(await subtle.digest('SHA-256', bytes(plain)))
  const mac = await subtle.sign('HMAC', ivKey,
    bytes(encoder.encode(JSON.stringify(['iv', input.keyId, input.epoch, input.path, input.seq, plainHash]))))
  const iv = new Uint8Array(mac).slice(0, 12)
  const aesKey = await subtle.importKey('raw', bytes(input.keyBytes), { name: 'AES-GCM' }, false, ['encrypt'])
  const sealed = await subtle.encrypt(
    { name: 'AES-GCM', iv: bytes(iv), additionalData: bytes(buildPayloadAad(input.path, input.seq, input.keyId)) },
    aesKey, bytes(plain))
  return {
    ciphertext: btoa(Array.from(new Uint8Array(sealed), b => String.fromCharCode(b)).join('')),
    iv: btoa(Array.from(iv, b => String.fromCharCode(b)).join('')),
  }
}
