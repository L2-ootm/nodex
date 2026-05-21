// src/crypto/crypto.ts
// AES-GCM-256 WebCrypto wrappers for Nodex peer-to-peer content encryption.
//
// Uses global crypto.subtle — available in:
//   - Service Worker scope (browser)
//   - Page scope (browser)
//   - Node.js 24 via globalThis.crypto (no polyfill needed)
//
// T-03-04: fresh 12-byte IV generated per encrypt call via crypto.getRandomValues
// T-03-03: AES-GCM auth tag causes DOMException(OperationError) on tamper/wrong-key — re-thrown to caller
// T-03-05 (accepted risk): extractable=true for PoC; production should set extractable=false

/**
 * Import a 32-byte raw key as an AES-GCM CryptoKey.
 *
 * @param rawBytes — 32-byte Uint8Array (256-bit AES key)
 * @returns CryptoKey usable for encrypt and decrypt operations
 */
export async function importKey(rawBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    rawBytes as unknown as Uint8Array<ArrayBuffer>,
    { name: 'AES-GCM' },
    true,               // extractable=true (PoC only — T-03-05 accepted risk)
    ['encrypt', 'decrypt'],
  )
}

/**
 * Encrypt plaintext with AES-GCM-256.
 *
 * T-03-04: generates a fresh 12-byte IV per call via crypto.getRandomValues.
 * The IV must be stored alongside the ciphertext and passed to decrypt.
 *
 * @param plaintext — data to encrypt
 * @param key       — CryptoKey from importKey()
 * @returns { ciphertext, iv } — both as Uint8Array
 */
export async function encrypt(
  plaintext: Uint8Array,
  key: CryptoKey,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const result = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as Uint8Array<ArrayBuffer> },
    key,
    plaintext as unknown as Uint8Array<ArrayBuffer>,
  )
  return { ciphertext: new Uint8Array(result), iv }
}

/**
 * Decrypt AES-GCM-256 ciphertext.
 *
 * T-03-03: If the ciphertext is tampered or the key is wrong, AES-GCM's
 * authentication tag verification fails and crypto.subtle.decrypt throws
 * DOMException(OperationError). This function re-throws to the caller —
 * the caller is responsible for falling back to the origin server.
 *
 * @param ciphertext — encrypted bytes (including GCM auth tag)
 * @param iv         — 12-byte IV used during encryption
 * @param key        — CryptoKey from importKey()
 * @returns decrypted plaintext as Uint8Array
 * @throws DOMException(OperationError) if auth tag fails (wrong key or tampered payload)
 */
export async function decrypt(
  ciphertext: Uint8Array,
  iv: Uint8Array,
  key: CryptoKey,
): Promise<Uint8Array> {
  try {
    const result = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as Uint8Array<ArrayBuffer> },
      key,
      ciphertext as unknown as Uint8Array<ArrayBuffer>,
    )
    return new Uint8Array(result)
  } catch (err) {
    console.warn('[crypto] decrypt failed — auth tag mismatch or wrong key:', err)
    throw err
  }
}
