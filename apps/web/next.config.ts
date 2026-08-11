import type { NextConfig } from 'next'

const apiProxyTarget = (process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000').replace(/\/$/, '')

const nextConfig: NextConfig = {
  transpilePackages: ['@vibe-writer/contracts'],
  async rewrites() {
    return {
      fallback: [{
        source: '/api/:path*',
        destination: `${apiProxyTarget}/:path*`,
      }],
    }
  },
}

export default nextConfig
