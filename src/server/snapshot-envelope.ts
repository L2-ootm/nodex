import { PROOF_HEADER } from '../crypto/publisher-proof.js'
import { sealSnapshot } from '../crypto/snapshot-seal.js'
import { canonicalSnapshot } from './sequence-authority.js'
import { getPublisher, publishProof } from './publisher.js'

export interface SnapshotEnvelope { ciphertext: string; iv: string; proof: string; validatedAt: number }

/**
 * A signed proof is reusable for this long. Reuse cannot extend staleness: the proof's signed
 * validUntil still ends at validatedAt + 5 s, so a reader that receives a reused proof only has a
 * correspondingly shorter usable window. It turns signing and authority-read load from
 * O(reader reads) into O(keys) per window.
 */
export const PROOF_REUSE_MS = 1_000
const MAX_MEMO_ENTRIES = 1_000
// Stores the in-flight promise so a concurrent burst shares one signature.
const proofMemo = new Map<string, { signed: Promise<string>; validatedAt: number }>()

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
  // The IV already encodes resource, version, epoch and plaintext hash, so it distinguishes payloads.
  const memoKey = `${input.path}|${input.seq}|${iv}|${input.keyId}|${input.scope ?? 'public'}`
  const now = Date.now()
  const hit = proofMemo.get(memoKey)
  if (hit && now >= hit.validatedAt && now - hit.validatedAt < PROOF_REUSE_MS) {
    return { ciphertext, iv, proof: await hit.signed, validatedAt: hit.validatedAt }
  }
  const signed = publishProof({ resource: input.path, version: input.seq, validatedAt: now,
    scope: input.scope, body: ciphertext, iv, encryptionKeyId: input.keyId })
  if (proofMemo.size >= MAX_MEMO_ENTRIES) {
    for (const [k, v] of proofMemo) if (now - v.validatedAt >= PROOF_REUSE_MS) proofMemo.delete(k)
    if (proofMemo.size >= MAX_MEMO_ENTRIES) proofMemo.clear()
  }
  proofMemo.set(memoKey, { signed, validatedAt: now })
  signed.catch(() => { if (proofMemo.get(memoKey)?.signed === signed) proofMemo.delete(memoKey) })
  return { ciphertext, iv, proof: await signed, validatedAt: now }
}

export function renewalHeaders(env: SnapshotEnvelope, seq: number, keyId: string): Record<string, string> {
  return { [PROOF_HEADER]: env.proof, 'X-Nodex-Seq': String(seq), 'X-Nodex-Iv': env.iv,
    'X-Nodex-Key-Id': keyId, 'X-Nodex-Validated-At': String(env.validatedAt),
    // A shared cache may hold this for 1 s: the signed validUntil, not the cache, bounds staleness, so an
    // edge hit only shortens the reader's usable window. The browser itself must always revalidate.
    'Cache-Control': 'public, max-age=0, s-maxage=1' }
}
