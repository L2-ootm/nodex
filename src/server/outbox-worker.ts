import {
  assertOutboxClaim,
  assertOutboxWorkerId,
  type InvalidationEvent,
  type InvalidationOutbox,
  type InvalidationSink,
} from './invalidation-outbox.js'

export interface OutboxWorkerOptions {
  workerId: string
  batchSize?: number
  leaseMs?: number
  concurrency?: number
  baseRetryMs?: number
  maxRetryMs?: number
}

export interface OutboxBatchResult {
  claimed: number
  delivered: number
  retried: number
  leaseLost: number
}

function retryDelay(attempts: number, baseMs: number, maxMs: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 20)
  return Math.min(maxMs, baseMs * (2 ** exponent))
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'delivery failed'
  return message.trim().slice(0, 1_024) || 'delivery failed'
}

async function runPool<T>(items: T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++
      await task(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
}

export async function runOutboxBatch(
  outbox: InvalidationOutbox,
  sink: InvalidationSink,
  options: OutboxWorkerOptions,
): Promise<OutboxBatchResult> {
  const batchSize = options.batchSize ?? 25
  const leaseMs = options.leaseMs ?? 30_000
  const concurrency = options.concurrency ?? 4
  const baseRetryMs = options.baseRetryMs ?? 1_000
  const maxRetryMs = options.maxRetryMs ?? 60_000
  assertOutboxWorkerId(options.workerId)
  assertOutboxClaim(batchSize, leaseMs)
  if (
    !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32 ||
    !Number.isInteger(baseRetryMs) || baseRetryMs < 0 ||
    !Number.isInteger(maxRetryMs) || maxRetryMs < baseRetryMs || maxRetryMs > 3_600_000
  ) {
    throw new TypeError('invalid outbox worker options')
  }

  const events = await outbox.claim(options.workerId, batchSize, leaseMs)
  const result: OutboxBatchResult = { claimed: events.length, delivered: 0, retried: 0, leaseLost: 0 }

  await runPool(events, concurrency, async (event: InvalidationEvent) => {
    try {
      await sink.deliver(event)
      if (await outbox.acknowledge(event.eventId, options.workerId)) result.delivered++
      else result.leaseLost++
    } catch (error) {
      const delay = retryDelay(event.attempts, baseRetryMs, maxRetryMs)
      if (await outbox.retry(event.eventId, options.workerId, delay, errorMessage(error))) result.retried++
      else result.leaseLost++
    }
  })

  return result
}
