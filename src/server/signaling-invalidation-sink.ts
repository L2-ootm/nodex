import {
  InvalidationOutboxUnavailableError,
  type InvalidationEvent,
  type InvalidationSink,
} from './invalidation-outbox.js'

export type OutboxFetch = typeof fetch

export class SignalingInvalidationSink implements InvalidationSink {
  constructor(
    private readonly endpoint: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: OutboxFetch = fetch,
    private readonly timeoutMs = 3_000,
  ) {
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || timeoutMs < 100 || timeoutMs > 30_000) {
      throw new TypeError('invalid signaling sink configuration')
    }
  }

  async deliver(event: InvalidationEvent): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tenantId: event.tenantId,
          key: event.resourceKey,
          seq: event.seq,
          eventId: event.eventId,
          originNodeId: 'server',
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!response.ok) throw new Error(`signaling returned ${response.status}`)
    } catch {
      throw new InvalidationOutboxUnavailableError()
    }
  }
}

export function createSignalingInvalidationSink(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: OutboxFetch = fetch,
): SignalingInvalidationSink {
  const baseUrl = env['NODEX_BETA_SIGNALING_HTTP_URL']
  const token = env['NODEX_SIGNALING_SEED_TOKEN']
  if (!baseUrl || (env['NODE_ENV'] === 'production' && !token)) {
    throw new InvalidationOutboxUnavailableError()
  }
  const endpoint = new URL('/gossip-seed', baseUrl).toString()
  return new SignalingInvalidationSink(endpoint, token, fetchImpl)
}
