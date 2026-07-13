import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get, put } from '@vercel/blob'
import { app } from './[id].js'

vi.mock('@vercel/blob', () => ({
  get: vi.fn(),
  put: vi.fn(),
}))

const mockedGet = vi.mocked(get)
const mockedPut = vi.mocked(put)

function sequenceBlob(value: unknown): Awaited<ReturnType<typeof get>> {
  return { stream: new Response(JSON.stringify(value)).body } as Awaited<ReturnType<typeof get>>
}

describe('product sequence authority', () => {
  beforeEach(() => {
    mockedGet.mockReset()
    mockedPut.mockReset()
    mockedPut.mockResolvedValue({} as Awaited<ReturnType<typeof put>>)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('fails closed when sequence storage is not configured', async () => {
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', '')
    const response = await app.request('/api/products/1')

    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Retry-After')).toBe('1')
    expect(mockedGet).not.toHaveBeenCalled()
  })

  it('fails closed when sequence storage is unavailable or missing', async () => {
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'configured')
    mockedGet.mockRejectedValueOnce(new Error('storage unavailable'))
    expect((await app.request('/api/products/1')).status).toBe(503)

    mockedGet.mockResolvedValueOnce(null)
    expect((await app.request('/api/products/1')).status).toBe(503)
  })

  it('fails closed instead of inventing missing sequence metadata', async () => {
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'configured')
    mockedGet.mockResolvedValueOnce(sequenceBlob({ seq: 1 }))
    expect((await app.request('/api/products/1')).status).toBe(503)

    mockedGet.mockResolvedValueOnce(sequenceBlob({ seq: 0, updatedAt: Date.now() }))
    expect((await app.request('/api/products/1')).status).toBe(503)
  })

  it('serves only a complete sequence-authority record', async () => {
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'configured')
    const updatedAt = Date.now() - 100
    mockedGet.mockResolvedValue(sequenceBlob({ seq: 7, updatedAt }))

    const response = await app.request('/api/products/1')

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Nodex-Seq')).toBe('7')
    expect(response.headers.get('X-Nodex-Updated-At')).toBe(String(updatedAt))
  })
})
