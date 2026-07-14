import { describe, expect, it, vi } from 'vitest'
import { InvalidationOutboxUnavailableError, type InvalidationEvent } from './invalidation-outbox.js'
import { createSignalingInvalidationSink, SignalingInvalidationSink } from './signaling-invalidation-sink.js'

const event: InvalidationEvent = {
  tenantId: '018f5b79-24c1-7a63-abfd-46a8c5ae23e7',
  eventId: '20000000-0000-4000-8000-000000000001',
  resourceKey: '/api/products/1',
  seq: 7,
  updatedAt: 1_000,
  attempts: 1,
}

describe('SignalingInvalidationSink', () => {
  it('delivers the stable event identity with server authentication', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const sink = new SignalingInvalidationSink('https://signal.example/gossip-seed', 'secret', fetchImpl)

    await sink.deliver(event)
    expect(fetchImpl).toHaveBeenCalledWith('https://signal.example/gossip-seed', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
      body: JSON.stringify({
        tenantId: event.tenantId,
        key: '/api/products/1',
        seq: 7,
        eventId: event.eventId,
        originNodeId: 'server',
      }),
    }))
  })

  it('treats non-success responses as retryable delivery failures', async () => {
    const sink = new SignalingInvalidationSink(
      'https://signal.example/gossip-seed',
      'secret',
      vi.fn().mockResolvedValue(new Response('{}', { status: 503 })),
    )
    await expect(sink.deliver(event)).rejects.toBeInstanceOf(InvalidationOutboxUnavailableError)
  })

  it('requires a seed token in production', () => {
    expect(() => createSignalingInvalidationSink({
      NODE_ENV: 'production',
      NODEX_BETA_SIGNALING_HTTP_URL: 'https://signal.example',
    })).toThrow(InvalidationOutboxUnavailableError)
  })
})
