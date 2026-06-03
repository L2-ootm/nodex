'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { authenticate } from '../lib/beta-api'
import { clearAll, readAuth, writeAuth } from '../lib/storage'

export function LoginPage() {
  const router = useRouter()
  const [token, setToken] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => {
    const saved = readAuth()
    if (!saved) return

    let active = true
    setStatus('Opening saved session...')
    authenticate(saved.token)
      .then((result) => {
        if (!active) return
        writeAuth({ ...result, token: saved.token })
        router.replace(result.role === 'admin' ? '/admin' : '/setup')
      })
      .catch(() => {
        if (!active) return
        clearAll()
        setStatus('Saved session expired. Enter your invitation again.')
      })

    return () => {
      active = false
    }
  }, [router])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const clean = token.trim()
    if (!clean) {
      setStatus('Paste your beta token to continue.')
      return
    }
    setStatus('Checking token...')
    try {
      const result = await authenticate(clean)
      const auth = { ...result, token: clean }
      writeAuth(auth)
      router.push(result.role === 'admin' ? '/admin' : '/setup')
    } catch (err) {
      if (err instanceof TypeError || (err as Error).message?.toLowerCase().includes('fetch')) {
        setStatus('Unable to reach the server. Check your connection and try again.')
      } else {
        setStatus('That token was not accepted. Check the invite and try again.')
      }
    }
  }

  return (
    <>
      <header className="public-topbar">
        <a className="suite-brand" href="/" aria-label="Nodex beta home">
          <span className="brand-mark image-mark" aria-hidden="true">
            <img src="/assets/nodex-x-emblem-clean.png" alt="" />
          </span>
          <span className="brand-wordmark">
            <span>
              <strong>Node<span>x</span></strong>
              <em>Beta</em>
            </span>
            <small>Validation suite</small>
          </span>
        </a>
      </header>

      <main className="login-page">
        <section className="login-copy">
          <p className="eyebrow">Private beta access</p>
          <h1>Nodex beta testing, guided.</h1>
          <p>Use your invitation, follow the steps, and send your test result.</p>
          <div className="trust-strip" aria-label="Beta safeguards">
            <span>Guided steps</span>
            <span>Evidence receipt</span>
            <span>Role-aware access</span>
          </div>
        </section>

        <figure className="brand-seal" aria-label="Nodex validation suite">
          <div className="brand-seal-stage">
            <img src="/assets/nodex-x-emblem-clean.png" alt="" />
          </div>
          <figcaption>
            <span>Nodex validation suite</span>
            <strong>Private beta access for browser testing.</strong>
          </figcaption>
        </figure>

      <section className="login-panel">
        <p className="eyebrow">Sign in</p>
        <h2>Enter your invitation</h2>
        <p>Tester tokens open the test. Admin tokens open the control room.</p>

        <form onSubmit={submit} className="form-stack">
          <label>
            Invitation token
            <input
              aria-label="Invitation token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
              placeholder="Paste your invitation token here"
            />
          </label>
          <button className="primary-button" type="submit" disabled={token.trim() === ''}>Continue</button>
        </form>

        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={status && (status.includes('not accepted') || status.includes('expired') || status.includes('expired')) ? 'status error' : 'status'}
        >{status}</p>
      </section>
    </main>
    </>
  )
}
