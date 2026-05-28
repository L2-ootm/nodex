/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: process.cwd(),
  async rewrites() {
    const apiOrigin = process.env.NEXT_PUBLIC_NODEX_BETA_API_URL || 'https://nodex-beta-api.vercel.app'
    return [
      {
        source: '/api/products/:path*',
        destination: `${apiOrigin}/api/products/:path*`,
      },
      {
        source: '/api/invalidate/:path*',
        destination: `${apiOrigin}/api/invalidate/:path*`,
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
