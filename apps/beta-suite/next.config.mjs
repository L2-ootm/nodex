/** @type {import('next').NextConfig} */
const nextConfig = {
  // Repository instructions are maintained outside Next's generated files.
  agentRules: false,
  outputFileTracingRoot: process.cwd(),
  async headers() {
    // script-src is not restricted: Next's inline bootstrap scripts need a nonce pipeline first.
    const security = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'" },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
      { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
    ]
    return [{ source: '/:path*', headers: security }]
  },
  async rewrites() {
    // When deployed as the API project (nodex-beta-api), the root api/ handlers are the
    // destination — rewrites that point back to the same host create an infinite loop (508).
    // Set NODEX_SKIP_API_REWRITES=1 on the nodex-beta-api Vercel project to disable them.
    if (process.env.NODEX_SKIP_API_REWRITES === '1') return []

    const apiOrigin = process.env.NEXT_PUBLIC_NODEX_BETA_API_URL ||
      (process.env.NODE_ENV === 'development' ? 'http://localhost:3003' : 'https://nodex-beta-api.vercel.app')
    return [
      {
        source: '/api/write/:path*',
        destination: `${apiOrigin}/api/write/:path*`,
      },
      {
        source: '/api/products/:path*',
        destination: `${apiOrigin}/api/products/:path*`,
      },
      {
        source: '/api/session-key',
        destination: `${apiOrigin}/api/session-key`,
      },
      {
        source: '/api/time',
        destination: `${apiOrigin}/api/time`,
      },
      {
        source: '/api/publisher-key',
        destination: `${apiOrigin}/api/publisher-key`,
      },
      {
        source: '/api/turn-credentials',
        destination: `${apiOrigin}/api/turn-credentials`,
      },
      {
        source: '/api/signal/:path*',
        destination: `${apiOrigin}/api/signal/:path*`,
      },
    ]
  },
}

export default nextConfig
