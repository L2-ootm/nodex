import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get, put } from '@vercel/blob'
import { app } from './[id].js'

const authorityRead = vi.hoisted(() => vi.fn())

vi.mock('../../src/server/sequence-authority-provider.js', () => ({
  getSequenceAuthority: () => ({ read: authorityRead }),
}))

vi.mock('@vercel/blob', () => ({
  get: vi.fn(),
  put: vi.fn(),
}))

const mockedGet = vi.mocked(get)
const mockedPut = vi.mocked(put)

describe('product sequence authority', () => {
  beforeEach(() => {
    authorityRead.mockReset()
    mockedGet.mockReset()
    mockedPut.mockReset()
    mockedPut.mockResolvedValue({} as Awaited<ReturnType<typeof put>>)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('fails closed when sequence storage is not configured', async () => {
    authorityRead.mockRejectedValueOnce(new Error('not configured'))
    const response = await app.request('/api/products/1')

    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Retry-After')).toBe('1')
    expect(authorityRead).toHaveBeenCalledWith('/api/products/1')
  })

  it('fails closed when sequence storage is unavailable or missing', async () => {
    authorityRead.mockRejectedValueOnce(new Error('storage unavailable'))
    expect((await app.request('/api/products/1')).status).toBe(503)

    authorityRead.mockRejectedValueOnce(new Error('missing row'))
    expect((await app.request('/api/products/1')).status).toBe(503)
  })

  it('fails closed instead of inventing missing sequence metadata', async () => {
    authorityRead.mockRejectedValueOnce(new Error('malformed row'))
    expect((await app.request('/api/products/1')).status).toBe(503)
  })

  it('serves only a complete sequence-authority record', async () => {
    const updatedAt = Date.now() - 100
    authorityRead.mockResolvedValue({ seq: 7, updatedAt })

    const response = await app.request('/api/products/1')

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Nodex-Seq')).toBe('7')
    expect(response.headers.get('X-Nodex-Updated-At')).toBe(String(updatedAt))
  })
})
