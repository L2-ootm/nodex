'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { authenticate } from '../lib/beta-api'
import { clearAll, readAuth, writeAuth } from '../lib/storage'

export function LoginPage() {
  const router = useRouter()
  const [token, setToken] = useState('')
  const [status, setStatus] = useState('')
  const [reveal, setReveal] = useState(false)
  const [remember, setRemember] = useState(false)

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
      writeAuth({ ...result, token: clean }, remember)
      router.push(result.role === 'admin' ? '/admin' : '/setup')
    } catch (err) {
      const message = (err as Error).message?.toLowerCase() ?? ''
      if (message.includes('too many')) {
        setStatus('Too many failed attempts from this network. Wait a few minutes before trying again.')
      } else if (err instanceof TypeError || message.includes('fetch')) {
        setStatus('Unable to reach the server. Check your connection and try again.')
      } else {
        setStatus('That token was not accepted. Check the invite and try again.')
      }
    }
  }

  const failed = /not accepted|expired|too many/.test(status)

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
            <span>Throttled sign-in</span>
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
              <span className="secret-field">
                <input
                  aria-label="Invitation token"
                  type={reveal ? 'text' : 'password'}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Paste token"
                />
                <button type="button" className="ghost-button" onClick={() => setReveal(!reveal)} aria-pressed={reveal}>
                  {reveal ? 'Hide' : 'Show'}
                </button>
              </span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
              <span>Remember me on this device <small>(off: the invitation is forgotten when you close this tab)</small></span>
            </label>
            <button className="primary-button" type="submit" disabled={token.trim() === ''}>Continue</button>
          </form>

          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={failed ? 'status error' : 'status'}
          >{status}</p>

          <ul className="security-notes" aria-label="How your invitation is protected">
            <li>The token goes only to the Nodex API over HTTPS, in a header, never in a URL.</li>
            <li>Repeated wrong tokens from one network are blocked for 10 minutes.</li>
            <li>Testing with another person? <Link href="/guide">Read the step-by-step guide</Link> (no sign-in needed).</li>
          </ul>
        </section>
      </main>
    </>
  )
}
