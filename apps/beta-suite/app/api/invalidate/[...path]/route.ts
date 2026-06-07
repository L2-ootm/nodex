import { type NextRequest, NextResponse } from 'next/server'
import { put, get } from '@vercel/blob'

function validateAdminToken(req: NextRequest): boolean {
  const header = req.headers.get('Authorization') ?? ''
  if (!header.startsWith('Bearer ')) return false
  const token = header.slice(7).trim()
  if (!token) return false
  const admins = (process.env['NODEX_BETA_ADMIN_TOKENS'] ?? '').split(',').map((t) => t.trim()).filter(Boolean)
  return admins.includes(token)
}

async function bumpSeq(path: string): Promise<number> {
  if (!process.env['BLOB_READ_WRITE_TOKEN']) return 1
  const blobKey = `nodex-seq/${path.replace(/\//g, '_')}.json`
  let seq = 1
  try {
    const blob = await get(blobKey, { access: 'private', useCache: false })
    if (blob?.stream) {
      const text = await new Response(blob.stream).text()
      const data = JSON.parse(text) as { seq: number }
      if (Number.isInteger(data.seq) && data.seq > 0) seq = data.seq + 1
    }
  } catch { /* not found — start at 1 */ }
  await put(blobKey, JSON.stringify({ seq }), {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json',
  })
  return seq
}

async function notifySignaling(path: string, seq: number): Promise<void> {
  const signalingUrl = process.env['NODEX_BETA_SIGNALING_HTTP_URL']
  if (!signalingUrl) return
  try {
    await fetch(`${signalingUrl}/gossip-seed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: path, seq, originNodeId: 'server' }),
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
  const seq = await bumpSeq(apiPath)
  void notifySignaling(apiPath, seq)
  return NextResponse.json({ path: apiPath, seq, invalidated: true })
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  })
}
