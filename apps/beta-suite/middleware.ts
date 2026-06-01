import { type NextRequest, NextResponse } from 'next/server'

export const config = {
  matcher: [
    '/api/signal/:path*',
    '/api/session-key',
    '/api/turn-credentials',
    '/api/invalidate/(.*)',  // (.*) needed to match nested paths like /products/1
    '/api/products/:path*',
  ],
}

interface Bucket { count: number; windowStart: number }
const buckets = new Map<string, Bucket>()
const WINDOW_MS = 60_000

const LIMITS: Record<string, number> = {
  signal: 1200,    // 2 nodes × 2req/s (poll+preflight) × 60s × headroom
  key: 20,         // fetched once on load
  turn: 20,        // fetched once on init
  invalidate: 10,  // admin-only, infrequent
  products: 200,   // product reads, CDN-style
}

function routeGroup(pathname: string): string | null {
  if (pathname.startsWith('/api/signal/')) return 'signal'
  if (pathname === '/api/session-key') return 'key'
  if (pathname === '/api/turn-credentials') return 'turn'
  if (pathname.startsWith('/api/invalidate/')) return 'invalidate'
  if (pathname.startsWith('/api/products/')) return 'products'
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
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization,content-type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      },
    })
  }

  bucket.count++
  return NextResponse.next()
}
