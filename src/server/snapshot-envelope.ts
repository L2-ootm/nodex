import { PROOF_HEADER } from '../crypto/publisher-proof.js'
import { sealSnapshot } from '../crypto/snapshot-seal.js'
import { canonicalSnapshot } from './sequence-authority.js'
import { getPublisher, publishProof } from './publisher.js'

export interface SnapshotEnvelope { ciphertext: string; iv: string; proof: string; validatedAt: number }

/**
 * One code path for the payload response and the renewal endpoint, so the renewed proof signs
 * exactly the ciphertext digest a peer already holds. Payload bytes depend only on
 * (resource, version, plaintext); only the proof's validatedAt changes per call.
 */
export async function snapshotEnvelope(input: {
  path: string; seq: number; payload: Record<string, unknown>; keyBytes: Uint8Array; keyId: string
  scope?: 'public' | 'private'
}): Promise<SnapshotEnvelope> {
  const { identity } = await getPublisher()
  const { ciphertext, iv } = await sealSnapshot({ keyBytes: input.keyBytes, keyId: input.keyId,
    epoch: identity.epoch, path: input.path, seq: input.seq, plaintext: canonicalSnapshot(input.payload) })
  const validatedAt = Date.now()
  const proof = await publishProof({ resource: input.path, version: input.seq, validatedAt,
    scope: input.scope, body: ciphertext, iv, encryptionKeyId: input.keyId })
  return { ciphertext, iv, proof, validatedAt }
}

export function renewalHeaders(env: SnapshotEnvelope, seq: number, keyId: string): Record<string, string> {
  return { [PROOF_HEADER]: env.proof, 'X-Nodex-Seq': String(seq), 'X-Nodex-Iv': env.iv,
    'X-Nodex-Key-Id': keyId, 'X-Nodex-Validated-At': String(env.validatedAt), 'Cache-Control': 'no-store' }
}
