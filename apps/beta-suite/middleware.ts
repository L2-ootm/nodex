import { type NextRequest, NextResponse } from 'next/server'

export const config = {
  matcher: [
    '/api/signal/:path*',
    '/api/session-key',
    '/api/turn-credentials',
  ],
}

interface Bucket { count: number; windowStart: number }
const buckets = new Map<string, Bucket>()
const WINDOW_MS = 60_000

const LIMITS: Record<string, number> = {
  signal: 120,   // 500ms poll × 2 testers × headroom
  key: 20,       // fetched once on load
  turn: 20,      // fetched once on init
}

function routeGroup(pathname: string): string | null {
  if (pathname.startsWith('/api/signal/')) return 'signal'
  if (pathname === '/api/session-key') return 'key'
  if (pathname === '/api/turn-credentials') return 'turn'
  return null
}

export function middleware(req: NextRequest) {
  const group = routeGroup(req.nextUrl.pathname)
  if (!group) return NextResponse.next()

  const limit = LIMITS[group]!
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const bucketKey = `${ip}:${group}`
  const now = Date.now()
  const bucket = buckets.get(bucketKey)

  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    buckets.set(bucketKey, { count: 1, windowStart: now })
    return NextResponse.next()
  }

  if (bucket.count >= limit) {
    return new NextResponse(JSON.stringify({ error: 'rate limited' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '60',
      },
    })
  }

  bucket.count++
  return NextResponse.next()
}
