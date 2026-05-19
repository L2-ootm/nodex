import { describe, it, expect } from 'vitest'
import {
  CACHE_URL_PREFIX,
  CACHE_MAX_BYTES,
  META_STORE,
  METRICS_BUFFER_STORE,
  METRICS_BUFFER_MAX,
  METRICS_CHANNEL_NAME,
  IDB_VERSION,
} from './config.js'

describe('shared/config', () => {
  it('CACHE_URL_PREFIX is /api/', () => {
    expect(CACHE_URL_PREFIX).toBe('/api/')
  })

  it('CACHE_MAX_BYTES is 31457280 (30MB)', () => {
    expect(CACHE_MAX_BYTES).toBe(31457280)
  })

  it('META_STORE is nodex-meta', () => {
    expect(META_STORE).toBe('nodex-meta')
  })

  it('METRICS_BUFFER_STORE is nodex-metrics-buffer', () => {
    expect(METRICS_BUFFER_STORE).toBe('nodex-metrics-buffer')
  })

  it('METRICS_BUFFER_MAX is 1000', () => {
    expect(METRICS_BUFFER_MAX).toBe(1000)
  })

  it('METRICS_CHANNEL_NAME is nodex-metrics', () => {
    expect(METRICS_CHANNEL_NAME).toBe('nodex-metrics')
  })

  it('IDB_VERSION is 1', () => {
    expect(IDB_VERSION).toBe(1)
  })
})
