import { type NextRequest, NextResponse } from 'next/server'
import {
  SequenceAuthorityInputError,
  type SequenceBump,
} from '../../../../../../src/server/sequence-authority'
import { getSequenceAuthority } from '../../../../../../src/server/sequence-authority-provider'

function validateAdminToken(req: NextRequest): boolean {
  const header = req.headers.get('Authorization') ?? ''
  if (!header.startsWith('Bearer ')) return false
  const token = header.slice(7).trim()
  if (!token) return false
  const admins = (process.env['NODEX_BETA_ADMIN_TOKENS'] ?? '').split(',').map((t) => t.trim()).filter(Boolean)
  return admins.includes(token)
}

async function notifySignaling(path: string, seq: number, eventId: string): Promise<void> {
  const signalingUrl = process.env['NODEX_BETA_SIGNALING_HTTP_URL']
  if (!signalingUrl) return
  try {
    await fetch(`${signalingUrl}/gossip-seed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: path, seq, eventId, originNodeId: 'server' }),
      signal: AbortSignal.timeout(3000),
    })
  } catch { /* signaling offline — gossip propagates on next peer contact */ }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  if (!validateAdminToken(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { path } = await params
  const wildcardPath = '/' + path.join('/')
  if (wildcardPath === '/') return NextResponse.json({ error: 'path required' }, { status: 400 })
  const apiPath = `/api${wildcardPath}`
  const idempotencyKey = req.headers.get('Idempotency-Key') ?? ''
  let bump: SequenceBump
  try {
    bump = await getSequenceAuthority().bump(apiPath, idempotencyKey)
  } catch (error) {
    if (error instanceof SequenceAuthorityInputError) {
      return NextResponse.json({ error: 'invalid invalidation command' }, { status: 400 })
    }
    return NextResponse.json(
      { error: 'sequence authority unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' } },
    )
  }
  void notifySignaling(apiPath, bump.seq, bump.eventId)
  return NextResponse.json({
    path: apiPath,
    seq: bump.seq,
    updatedAt: bump.updatedAt,
    eventId: bump.eventId,
    duplicate: bump.duplicate,
    invalidated: true,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
    },
  })
}
