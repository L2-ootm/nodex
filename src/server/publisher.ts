import { contentDigest, encodeProof, signProof, PROOF_MAX_AGE_MS, INVALIDATION_PROOF_MAX_AGE_MS,
  type PublisherIdentity, type PublisherProof } from '../crypto/publisher-proof.js'
import { SEQUENCE_UUID_PATTERN } from './sequence-authority.js'

// Development processes use an ephemeral key. Production must share a configured
// private JWK across origin/API/outbox instances. It is never sent to a reader.
const state = globalThis as typeof globalThis & {
  __nodexPublisher?: { config: string; value: Promise<{ identity: PublisherIdentity; privateKey: CryptoKey }> }
}
export async function getPublisher() {
  const raw = process.env['NODEX_PUBLISHER_PRIVATE_JWK'] ?? ''
  const tenant = process.env['NODEX_TENANT_ID'] ?? 'default'
  const epoch = process.env['NODEX_PUBLISHER_EPOCH'] ?? 'development'
  if (process.env['NODE_ENV'] === 'production' && (!raw || !SEQUENCE_UUID_PATTERN.test(tenant) ||
    !/^[a-zA-Z0-9._-]{1,160}$/.test(epoch) || epoch === 'development')) {
    throw new Error('Publisher configuration unavailable')
  }
  const config = JSON.stringify([raw, tenant, epoch])
  if (state.__nodexPublisher?.config !== config) {
    state.__nodexPublisher = { config, value: (async () => {
      let privateKey: CryptoKey
      let publicJwk: JsonWebKey
      if (raw) {
        const jwk = JSON.parse(raw) as JsonWebKey
        if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d) throw new Error('Invalid publisher key')
        privateKey = await crypto.subtle.importKey('jwk', { ...jwk, key_ops: ['sign'] },
          { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
        publicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, key_ops: ['verify'], ext: true }
      } else {
        const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
        privateKey = pair.privateKey
        publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
      }
      // Ephemeral development authorities restart their sequence state. Give each
      // process a distinct domain; production epoch changes are explicit migrations.
      const authorityEpoch = raw ? epoch : `dev-${(await contentDigest(JSON.stringify([publicJwk.x, publicJwk.y]))).slice(0, 24)}`
      const keyId = (await contentDigest(JSON.stringify([publicJwk.x, publicJwk.y, tenant, authorityEpoch]))).slice(0, 24)
      return { identity: { tenant, epoch: authorityEpoch, keyId, publicJwk }, privateKey }
    })() }
  }
  return state.__nodexPublisher.value
}
export async function publishProof(input: {
  kind?: PublisherProof['kind']; scope?: PublisherProof['scope']; resource: string; version: number;
  validatedAt: number; body?: string; iv?: string; encryptionKeyId?: string;
}): Promise<string> {
  const { identity, privateKey } = await getPublisher()
  const proof = await signProof({
    format: 1, kind: input.kind ?? 'content', scope: input.scope ?? 'public', tenant: identity.tenant, epoch: identity.epoch,
    signingKeyId: identity.keyId, resource: input.resource, version: input.version,
    validatedAt: input.validatedAt, validUntil: input.validatedAt + (input.kind === 'invalidation' ? INVALIDATION_PROOF_MAX_AGE_MS : PROOF_MAX_AGE_MS),
    digest: input.body === undefined ? '' : await contentDigest(input.body),
    iv: input.iv ?? '', encryptionKeyId: input.encryptionKeyId ?? '',
  }, privateKey)
  return encodeProof(proof)
}
