import { describe, it, expect, beforeEach } from 'vitest'
import { validateBetaToken } from './auth.js'

describe('validateBetaToken', async () => {
  beforeEach(() => {
    process.env['NODEX_BETA_TOKENS'] = 'nodex-tester-abc123|Alice||,nodex-tester-def456|Bob||'
    process.env['NODEX_BETA_ADMIN_TOKENS'] = 'nodex-admin-xyz789'
  })

  it('accepts valid tester token for tester role', async () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer nodex-tester-abc123' },
    })
    expect(await validateBetaToken(req, 'tester')).toBe(true)
  })

  it('accepts admin token for tester role', async () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer nodex-admin-xyz789' },
    })
    expect(await validateBetaToken(req, 'tester')).toBe(true)
  })

  it('rejects tester token for admin role', async () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer nodex-tester-abc123' },
    })
    expect(await validateBetaToken(req, 'admin')).toBe(false)
  })

  it('accepts admin token for admin role', async () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer nodex-admin-xyz789' },
    })
    expect(await validateBetaToken(req, 'admin')).toBe(true)
  })

  it('rejects missing Authorization header', async () => {
    const req = new Request('http://localhost')
    expect(await validateBetaToken(req, 'tester')).toBe(false)
  })

  it('rejects unknown token', async () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer nodex-tester-unknown999' },
    })
    expect(await validateBetaToken(req, 'tester')).toBe(false)
  })

  it('rejects malformed Authorization header', async () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'nodex-tester-abc123' },
    })
    expect(await validateBetaToken(req, 'tester')).toBe(false)
  })
})
