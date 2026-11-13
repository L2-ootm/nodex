import { configuredSessionKey } from '../../src/server/session-key.js'
import { getSequenceAuthority } from '../../src/server/sequence-authority-provider.js'
import { snapshotEnvelope, type SnapshotEnvelope } from '../../src/server/snapshot-envelope.js'

export type LoadedProduct =
  | { ok: true; path: string; seq: number; updatedAt: number; keyId: string; env: SnapshotEnvelope }
  | { ok: false; status: 400 | 503; body: string }

/** Shared by the payload route and the proof-renewal route so both sign identical ciphertext bytes. */
export async function loadProductEnvelope(id: string): Promise<LoadedProduct> {
  if (!/^[a-zA-Z0-9_-]{1,240}$/.test(id)) return { ok: false, status: 400, body: 'invalid product id' }
  const path = `/api/products/${id}`
  let authority
  try { authority = await getSequenceAuthority().read(path) }
  catch { return { ok: false, status: 503, body: 'Sequence authority unavailable' } }
  const { bytes: keyBytes, keyId } = configuredSessionKey()
  const payload = authority.payload ?? { id, name: `Product ${id}`, price: 9.99 }
  const env = await snapshotEnvelope({ path, seq: authority.seq, payload, keyBytes, keyId })
  return { ok: true, path, seq: authority.seq, updatedAt: authority.updatedAt, keyId, env }
}
