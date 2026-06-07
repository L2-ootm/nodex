import { describe, it, expect } from 'vitest'
import {
  CACHE_URL_PREFIX,
  CACHE_MAX_BYTES,
  DEFAULT_API_ORIGIN,
  DEFAULT_APP_ORIGIN,
  DEFAULT_ICE_TRANSPORT_POLICY,
  DEFAULT_SIGNALING_URL,
  ICE_SERVERS,
  META_STORE,
  METRICS_BUFFER_STORE,
  METRICS_BUFFER_MAX,
  METRICS_CHANNEL_NAME,
  IDB_VERSION,
  buildSignalingUrl,
  parseIceServersJson,
  resolveNodexRuntimeConfig,
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

  it('IDB_VERSION is 2', () => {
    expect(IDB_VERSION).toBe(2)
  })

  it('keeps external-validity runtime defaults compatible with localhost PoC', () => {
    const config = resolveNodexRuntimeConfig()

    expect(DEFAULT_APP_ORIGIN).toBe('http://localhost:4173')
    expect(DEFAULT_API_ORIGIN).toBe('http://localhost:3001')
    expect(DEFAULT_SIGNALING_URL).toBe('ws://localhost:3002/ws')
    expect(DEFAULT_ICE_TRANSPORT_POLICY).toBe('all')
    expect(config.signalingUrl).toBe(DEFAULT_SIGNALING_URL)
    expect(config.iceServers).toEqual(ICE_SERVERS)
    expect(config.forceRelay).toBe(false)
  })

  it('parses injected STUN/TURN ICE servers without changing safe defaults', () => {
    const injected = JSON.stringify([
      { urls: 'stun:stun.example.test:19302' },
      { urls: ['turn:turn.example.test:3478'], username: 'user', credential: 'secret' },
    ])

    expect(parseIceServersJson(injected)).toEqual([
      { urls: 'stun:stun.example.test:19302' },
      { urls: ['turn:turn.example.test:3478'], username: 'user', credential: 'secret' },
    ])
    expect(parseIceServersJson('not-json')).toEqual(ICE_SERVERS)
    expect(parseIceServersJson('[{"urls":""}]')).toEqual(ICE_SERVERS)
  })

  it('resolves external runtime config from explicit overrides', () => {
    const config = resolveNodexRuntimeConfig({
      appOrigin: 'https://app.example.test',
      apiOrigin: 'https://api.example.test',
      signalingUrl: 'wss://signal.example.test/ws',
      iceServersJson: '[{"urls":"turn:turn.example.test:3478","username":"u","credential":"p"}]',
      forceRelay: true,
    })

    expect(config.appOrigin).toBe('https://app.example.test')
    expect(config.apiOrigin).toBe('https://api.example.test')
    expect(config.signalingUrl).toBe('wss://signal.example.test/ws')
    expect(config.iceTransportPolicy).toBe('relay')
    expect(config.iceServers[0]).toEqual({
      urls: 'turn:turn.example.test:3478',
      username: 'u',
      credential: 'p',
    })
  })

  it('adds room to signaling URL while preserving existing query params', () => {
    const url = buildSignalingUrl('room with spaces', 'wss://signal.example.test/ws?token=abc')

    expect(url).toBe('wss://signal.example.test/ws?token=abc&room=room+with+spaces')
  })
})
