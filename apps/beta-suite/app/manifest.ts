import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Nodex Beta Validation Suite',
    short_name: 'Nodex Beta',
    description: 'Private Nodex beta validation workspace.',
    start_url: '/',
    display: 'standalone',
    background_color: '#02080a',
    theme_color: '#16d8e8',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  }
}
