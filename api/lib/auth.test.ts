import { describe, it, expect, beforeEach } from 'vitest'
import { validateBetaToken } from './auth.js'

describe('validateBetaToken', () => {
  beforeEach(() => {
    process.env['NODEX_BETA_TOKENS'] = 'nodex-tester-abc123|Alice||,nodex-tester-def456|Bob||'
    process.env['NODEX_BETA_ADMIN_TOKENS'] = 'nodex-admin-xyz789'
  })

  it('accepts valid tester token for tester role', () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer nodex-tester-abc123' },
    })
    expect(validateBetaToken(req, 'tester')).toBe(true)
  })

  it('accepts admin token for tester role', () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer nodex-admin-xyz789' },
    })
    expect(validateBetaToken(req, 'tester')).toBe(true)
  })

  it('rejects tester token for admin role', () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer nodex-tester-abc123' },
    })
    expect(validateBetaToken(req, 'admin')).toBe(false)
  })

  it('accepts admin token for admin role', () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer nodex-admin-xyz789' },
    })
    expect(validateBetaToken(req, 'admin')).toBe(true)
  })

  it('rejects missing Authorization header', () => {
    const req = new Request('http://localhost')
    expect(validateBetaToken(req, 'tester')).toBe(false)
  })

  it('rejects unknown token', () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer nodex-tester-unknown999' },
    })
    expect(validateBetaToken(req, 'tester')).toBe(false)
  })

  it('rejects malformed Authorization header', () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'nodex-tester-abc123' },
    })
    expect(validateBetaToken(req, 'tester')).toBe(false)
  })
})
