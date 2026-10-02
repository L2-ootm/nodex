import { type NextRequest, NextResponse } from 'next/server'
import { SEQUENCE_UUID_PATTERN } from '../../../../../../src/server/sequence-authority'

/** API owns authorization, database mutations and durable invalidation delivery. */
export async function POST(req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const authorization = req.headers.get('Authorization') ?? ''
  if (!authorization.startsWith('Bearer ') || authorization.length > 4096) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { path } = await params
  const suffix = '/' + path.join('/')
  const key = suffix.startsWith('/api/') ? suffix : '/api' + suffix
  const idempotency = req.headers.get('Idempotency-Key') ?? ''
  if (!/^\/api\/products\/[a-zA-Z0-9_-]{1,240}$/.test(key) || !SEQUENCE_UUID_PATTERN.test(idempotency)) {
    return NextResponse.json({ error: 'invalid invalidation command' }, { status: 400 })
  }
  const apiOrigin = process.env['NEXT_PUBLIC_NODEX_BETA_API_URL'] || 'https://nodex-beta-api.vercel.app'
  try {
    const response = await fetch(new URL('/api/invalidate' + key, apiOrigin), {
      method: 'POST', headers: { Authorization: authorization, 'Idempotency-Key': idempotency },
      cache: 'no-store', signal: AbortSignal.timeout(5000),
    })
    return new Response(response.body, { status: response.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        ...(response.headers.get('Retry-After') ? { 'Retry-After': response.headers.get('Retry-After')! } : {}) } })
  } catch {
    return NextResponse.json({ error: 'sequence authority unavailable' }, {
      status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' },
    })
  }
}
