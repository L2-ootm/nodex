/** Publisher authenticity is separate from the shared AES confidentiality key. */
export const PROOF_HEADER = 'X-Nodex-Publisher-Proof'
export const PROOF_MAX_AGE_MS = 5_000
export const INVALIDATION_PROOF_MAX_AGE_MS = 120_000
export interface PublisherIdentity {
  tenant: string
  epoch: string
  keyId: string
  publicJwk: JsonWebKey
}
export interface PublisherProof {
  format: 1
  kind: 'content' | 'invalidation'
  scope: 'public' | 'private'
  tenant: string
  epoch: string
  signingKeyId: string
  resource: string
  version: number
  validatedAt: number
  validUntil: number
  digest: string
  iv: string
  encryptionKeyId: string
  signature: string
}

function bytes(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer
}
function base64(value: Uint8Array): string {
  return btoa(Array.from(value, byte => String.fromCharCode(byte)).join(''))
}
export function encodeProof(proof: PublisherProof): string {
  return base64(new TextEncoder().encode(JSON.stringify(proof)))
}
export function decodeProof(encoded: string | null): PublisherProof | null {
  if (!encoded || encoded.length > 4_096) return null
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(encoded), c => c.charCodeAt(0))))
    if (!value || typeof value !== 'object') return null
    const p = value as PublisherProof
    if (p.format !== 1 || !['content', 'invalidation'].includes(p.kind) || !['public', 'private'].includes(p.scope)) return null
    if (![p.tenant, p.epoch, p.signingKeyId, p.resource, p.signature].every(
      s => typeof s === 'string' && s.length > 0 && s.length <= 512)) return null
    if (!p.resource.startsWith('/api/products/') || /[?#]/.test(p.resource)) return null
    if (![p.version, p.validatedAt, p.validUntil].every(n => Number.isSafeInteger(n) && n > 0)) return null
    const maxAge = p.kind === 'invalidation' ? INVALIDATION_PROOF_MAX_AGE_MS : PROOF_MAX_AGE_MS
    if (p.validUntil < p.validatedAt || p.validUntil - p.validatedAt > maxAge) return null
    if (![p.digest, p.iv, p.encryptionKeyId].every(s => typeof s === 'string' && s.length <= 512)) return null
    return p
  } catch { return null }
}
function canonical(p: Omit<PublisherProof, 'signature'>): Uint8Array {
  // Fixed tuple prevents JSON ordering and delimiter ambiguity.
  return new TextEncoder().encode(JSON.stringify([
    'nodex-publisher-v1', p.kind, p.scope, p.tenant, p.epoch, p.signingKeyId, p.resource,
    p.version, p.validatedAt, p.validUntil, p.digest, p.iv, p.encryptionKeyId,
  ]))
}
export async function contentDigest(body: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  return base64(new Uint8Array(hash))
}
export async function signProof(
  proof: Omit<PublisherProof, 'signature'>, privateKey: CryptoKey,
): Promise<PublisherProof> {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privateKey, bytes(canonical(proof)))
  return { ...proof, signature: base64(new Uint8Array(signature)) }
}
export async function verifyProof(
  proof: PublisherProof, identity: PublisherIdentity, resource: string,
  kind: PublisherProof['kind'], body?: string, now = Date.now(),
): Promise<boolean> {
  try {
    if (!decodeProof(encodeProof(proof)) || proof.kind !== kind || proof.resource !== resource) return false
    if (proof.tenant !== identity.tenant || proof.epoch !== identity.epoch || proof.signingKeyId !== identity.keyId) return false
    if (proof.validatedAt > now + 1_000 || proof.validUntil <= now) return false
    if (kind === 'content' && (body === undefined || proof.digest !== await contentDigest(body))) return false
    if (identity.publicJwk.d || identity.publicJwk.kty !== 'EC' || identity.publicJwk.crv !== 'P-256') return false
    const key = await crypto.subtle.importKey('jwk', identity.publicJwk,
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
      bytes(Uint8Array.from(atob(proof.signature), c => c.charCodeAt(0))), bytes(canonical(proof)))
  } catch { return false }
}

/** Signed server time bound to a client nonce: a cached or replayed response cannot match a fresh nonce. */
export interface SignedTime {
  format: 1; nonce: string; serverMs: number; tenant: string; epoch: string; signingKeyId: string; signature: string
}
export const TIME_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
function canonicalTime(t: Omit<SignedTime, 'signature'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(
    ['nodex-time-v1', t.nonce, t.serverMs, t.tenant, t.epoch, t.signingKeyId]))
}
export async function signTime(t: Omit<SignedTime, 'signature'>, privateKey: CryptoKey): Promise<SignedTime> {
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, bytes(canonicalTime(t)))
  return { ...t, signature: base64(new Uint8Array(signature)) }
}
export async function verifyTime(t: SignedTime, identity: PublisherIdentity, nonce: string): Promise<boolean> {
  try {
    if (t.format !== 1 || t.nonce !== nonce || !TIME_NONCE_PATTERN.test(nonce)) return false
    if (!Number.isSafeInteger(t.serverMs) || t.serverMs <= 0 || typeof t.signature !== 'string' || t.signature.length > 512) return false
    if (t.tenant !== identity.tenant || t.epoch !== identity.epoch || t.signingKeyId !== identity.keyId) return false
    if (identity.publicJwk.d || identity.publicJwk.kty !== 'EC' || identity.publicJwk.crv !== 'P-256') return false
    const key = await crypto.subtle.importKey('jwk', identity.publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
      bytes(Uint8Array.from(atob(t.signature), c => c.charCodeAt(0))), bytes(canonicalTime(t)))
  } catch { return false }
}
