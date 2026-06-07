/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: process.cwd(),
  async rewrites() {
    // When deployed as the API project (nodex-beta-api), the root api/ handlers are the
    // destination — rewrites that point back to the same host create an infinite loop (508).
    // Set NODEX_SKIP_API_REWRITES=1 on the nodex-beta-api Vercel project to disable them.
    if (process.env.NODEX_SKIP_API_REWRITES === '1') return []

    const apiOrigin = process.env.NEXT_PUBLIC_NODEX_BETA_API_URL || 'https://nodex-beta-api.vercel.app'
    return [
      {
        source: '/api/products/:path*',
        destination: `${apiOrigin}/api/products/:path*`,
      },
      {
        source: '/api/session-key',
        destination: `${apiOrigin}/api/session-key`,
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
