// src/crypto/crypto.test.ts
// Unit tests for AES-GCM-256 WebCrypto wrappers.
// Uses Node.js 24 globalThis.crypto — no polyfills needed.
// Each test generates its own key bytes to avoid shared state.

import { describe, it, expect } from 'vitest'
import { importKey, encrypt, decrypt } from './crypto.js'

// Helper: generate a random 32-byte key for each test
function randomKeyBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

// Helper: encode string to Uint8Array
function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

// Helper: decode Uint8Array to string
function decode(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}

describe('importKey', () => {
  it('returns a CryptoKey object for a 32-byte input', async () => {
    const keyBytes = randomKeyBytes()
    const key = await importKey(keyBytes)
    expect(key).not.toBeNull()
    expect(key).not.toBeUndefined()
    // CryptoKey objects have an algorithm property
    expect(key.algorithm).toBeDefined()
    expect((key.algorithm as { name: string }).name).toBe('AES-GCM')
  })
})

describe('encrypt / decrypt round-trip', () => {
  it('encrypt then decrypt returns the original UTF-8 plaintext', async () => {
    const keyBytes = randomKeyBytes()
    const key = await importKey(keyBytes)
    const plaintext = encode('Hello, Nodex P2P cache!')

    const { ciphertext, iv } = await encrypt(plaintext, key)
    const recovered = await decrypt(ciphertext, iv, key)

    expect(decode(recovered)).toBe('Hello, Nodex P2P cache!')
  })

  it('two encrypt calls with the same key and plaintext produce different IVs (IV freshness — T-03-04)', async () => {
    const keyBytes = randomKeyBytes()
    const key = await importKey(keyBytes)
    const plaintext = encode('test-data')

    const result1 = await encrypt(plaintext, key)
    const result2 = await encrypt(plaintext, key)

    // IVs must differ
    const iv1Hex = Array.from(result1.iv).map(b => b.toString(16).padStart(2, '0')).join('')
    const iv2Hex = Array.from(result2.iv).map(b => b.toString(16).padStart(2, '0')).join('')
    expect(iv1Hex).not.toBe(iv2Hex)
  })
})

describe('decrypt error cases (T-03-03)', () => {
  it('decrypt with a different key throws DOMException', async () => {
    const key1 = await importKey(randomKeyBytes())
    const key2 = await importKey(randomKeyBytes())  // different key
    const { ciphertext, iv } = await encrypt(encode('secret'), key1)

    let thrown: unknown = null
    try {
      await decrypt(ciphertext, iv, key2)
    } catch (err) {
      thrown = err
    }

    expect(thrown).not.toBeNull()
    expect(thrown instanceof DOMException).toBe(true)
  })

  it('decrypt with a tampered ciphertext byte throws DOMException', async () => {
    const keyBytes = randomKeyBytes()
    const key = await importKey(keyBytes)
    const { ciphertext, iv } = await encrypt(encode('tamper me'), key)

    // Flip the first byte of the ciphertext
    const tampered = new Uint8Array(ciphertext)
    tampered[0] = tampered[0] ^ 0xff

    let thrown: unknown = null
    try {
      await decrypt(tampered, iv, key)
    } catch (err) {
      thrown = err
    }

    expect(thrown).not.toBeNull()
    expect(thrown instanceof DOMException).toBe(true)
  })
})
