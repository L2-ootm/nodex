import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  metadataBase: new URL('https://nodex-beta.vercel.app'),
  title: {
    default: 'Nodex Beta Validation Suite',
    template: '%s | Nodex Beta',
  },
  description: 'Private Nodex beta validation workspace for guided browser network testing.',
  applicationName: 'Nodex Beta',
  generator: 'Next.js',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/assets/nodex-x-emblem-clean.png', type: 'image/png' },
    ],
    apple: [{ url: '/assets/nodex-x-emblem-clean.png' }],
  },
  openGraph: {
    title: 'Nodex Beta Validation Suite',
    description: 'Private Nodex beta validation workspace for guided browser network testing.',
    url: 'https://nodex-beta.vercel.app',
    siteName: 'Nodex Beta',
    images: [
      {
        url: '/assets/nodex-x-emblem-clean.png',
        width: 1024,
        height: 1024,
        alt: 'Nodex emblem',
      },
    ],
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Nodex Beta Validation Suite',
    description: 'Private Nodex beta validation workspace for guided browser network testing.',
    images: ['/assets/nodex-x-emblem-clean.png'],
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
