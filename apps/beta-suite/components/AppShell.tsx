'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { BetaRole, StoredAuth } from '../lib/types'
import { authenticate } from '../lib/beta-api'
import { clearAll, readAuth, readCachedAuth, writeAuth } from '../lib/storage'

const testerNav = [
  ['Setup', '/setup'],
  ['Profile', '/profile'],
  ['Room', '/room'],
  ['Run', '/run'],
  ['Evidence', '/evidence'],
  ['Receipt', '/receipt'],
] as const

const adminNav = [
  ['Overview', '/admin'],
  ['Tokens', '/admin/tokens'],
  ['Runs', '/admin/runs'],
  ['Monitor', '/admin/monitor'],
  ['Ledger', '/admin/ledger'],
  ['Audit', '/admin/audit'],
] as const

export function AppShell({
  children,
  requireRole,
  allowTester = false,
}: {
  children: React.ReactNode
  requireRole?: BetaRole
  allowTester?: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [auth, setAuth] = useState<StoredAuth | null>(() => readCachedAuth())
  const [ready, setReady] = useState(() => readCachedAuth() !== null)

  useEffect(() => {
    const stored = readAuth()
    if (!stored) {
      setAuth(null)
      setReady(true)
      router.replace('/')
      return
    }

    if (requireRole && stored.role !== requireRole) {
      setAuth(null)
      setReady(true)
      router.replace(stored.role === 'admin' ? '/admin' : '/room')
      return
    }
    setAuth(stored)
    setReady(true)

    let active = true
    authenticate(stored.token)
      .then((result) => {
        if (!active) return
        const verified = { ...result, token: stored.token }
        writeAuth(verified)
        if (requireRole && verified.role !== requireRole) {
          setAuth(null)
          setReady(true)
          router.replace(verified.role === 'admin' ? '/admin' : '/room')
          return
        }
        setAuth(verified)
        setReady(true)
      })
      .catch(() => {
        if (!active) return
        clearAll()
        setAuth(null)
        setReady(true)
        router.replace('/')
      })

    return () => {
      active = false
    }
  }, [requireRole, router, pathname])

  if (!ready || !auth) {
    return (
      <main className="app-loading">
        <div className="brand-mark image-mark" aria-hidden="true">
          <img src="/assets/nodex-x-emblem-clean.png" alt="" />
        </div>
        <p>Opening Nodex beta suite...</p>
      </main>
    )
  }

  const nav = auth.role === 'admin' ? adminNav : testerNav
  const title = auth.role === 'admin' ? 'Admin workspace' : 'Tester workspace'

  return (
    <div className="suite-shell">
      <header className="suite-header">
        <Link className="suite-brand" href={auth.role === 'admin' ? '/admin' : '/setup'}>
          <span className="brand-mark image-mark" aria-hidden="true">
            <img src="/assets/nodex-x-emblem-clean.png" alt="" />
          </span>
          <span className="brand-wordmark">
            <span>
              <strong>Node<span>x</span></strong>
              <em>Beta</em>
            </span>
            <small>Beta validation suite</small>
          </span>
        </Link>

        <nav className="suite-nav" aria-label={`${auth.role} navigation`}>
          {nav.map(([label, href]) => {
            if (!allowTester && auth.role === 'tester' && href.startsWith('/admin')) return null
            const active = pathname === href
            return (
              <Link key={href} href={href} className={active ? 'active' : ''}>
                {label}
              </Link>
            )
          })}
        </nav>

        <div className="session-cluster">
          <span className="role-chip" data-role={auth.role}>
            <b>{auth.role === 'admin' ? 'A' : 'T'}</b>
            {title}
          </span>
          <button
            className="ghost-button"
            type="button"
            onClick={() => {
              clearAll()
              router.replace('/')
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="suite-main">{children}</main>
    </div>
  )
}

export function PageIntro({
  eyebrow,
  title,
  body,
  aside,
}: {
  eyebrow: string
  title: string
  body: string
  aside?: React.ReactNode
}) {
  return (
    <section className="page-intro">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{body}</p>
      </div>
      {aside ? <div className="intro-aside">{aside}</div> : null}
    </section>
  )
}

export function StepRail({ current }: { current: 'setup' | 'profile' | 'room' | 'run' | 'evidence' | 'receipt' }) {
  const steps = [
    ['setup', 'Access'],
    ['profile', 'Profile'],
    ['room', 'Room'],
    ['run', 'Run'],
    ['evidence', 'Evidence'],
    ['receipt', 'Receipt'],
  ] as const
  const currentIndex = steps.findIndex(([id]) => id === current)
  return (
    <aside className="step-rail" aria-label="Test progress">
      {steps.map(([id, label], index) => (
        <Link key={id} href={`/${id === 'setup' ? 'setup' : id}`} className={index <= currentIndex ? 'done' : ''}>
          <span>{index + 1}</span>
          {label}
        </Link>
      ))}
    </aside>
  )
}

export function TesterLayout({ current, children }: { current: Parameters<typeof StepRail>[0]['current']; children: React.ReactNode }) {
  return (
    <AppShell requireRole="tester">
      <div className="tester-grid">
        <StepRail current={current} />
        <div>{children}</div>
      </div>
    </AppShell>
  )
}
