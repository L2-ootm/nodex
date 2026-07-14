import {
  assertSequenceResourceKey,
  assertSequenceUuid,
  MAX_SAFE_SEQUENCE,
} from './sequence-authority.js'

export const MAX_OUTBOX_BATCH_SIZE = 100
export const MAX_OUTBOX_LEASE_MS = 300_000
export const MAX_OUTBOX_RETRY_MS = 3_600_000

export interface InvalidationEvent {
  tenantId: string
  eventId: string
  resourceKey: string
  seq: number
  updatedAt: number
  attempts: number
}

export interface InvalidationOutbox {
  claim(workerId: string, limit: number, leaseMs: number): Promise<InvalidationEvent[]>
  acknowledge(eventId: string, workerId: string): Promise<boolean>
  retry(eventId: string, workerId: string, delayMs: number, error: string): Promise<boolean>
}

export interface InvalidationSink {
  deliver(event: InvalidationEvent): Promise<void>
}

export class InvalidationOutboxUnavailableError extends Error {
  constructor() {
    super('invalidation outbox unavailable')
    this.name = 'InvalidationOutboxUnavailableError'
  }
}

export class InvalidationOutboxInputError extends Error {
  constructor() {
    super('invalid invalidation outbox input')
    this.name = 'InvalidationOutboxInputError'
  }
}

export function assertOutboxWorkerId(workerId: string): void {
  try {
    assertSequenceUuid(workerId)
  } catch {
    throw new InvalidationOutboxInputError()
  }
}

export function assertOutboxClaim(limit: number, leaseMs: number): void {
  if (
    !Number.isInteger(limit) || limit < 1 || limit > MAX_OUTBOX_BATCH_SIZE ||
    !Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > MAX_OUTBOX_LEASE_MS ||
    leaseMs % 1_000 !== 0
  ) {
    throw new InvalidationOutboxInputError()
  }
}

export function assertOutboxRetry(delayMs: number, error: string): void {
  if (
    !Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_OUTBOX_RETRY_MS ||
    typeof error !== 'string' || error.length < 1 || error.length > 1_024
  ) {
    throw new InvalidationOutboxInputError()
  }
}

export function assertInvalidationEvent(event: InvalidationEvent): void {
  try {
    assertSequenceUuid(event.tenantId)
    assertSequenceUuid(event.eventId)
    assertSequenceResourceKey(event.resourceKey)
  } catch {
    throw new InvalidationOutboxUnavailableError()
  }
  if (
    !Number.isSafeInteger(event.seq) || event.seq < 1 || event.seq > MAX_SAFE_SEQUENCE ||
    !Number.isSafeInteger(event.updatedAt) || event.updatedAt <= 0 ||
    !Number.isInteger(event.attempts) || event.attempts < 1
  ) {
    throw new InvalidationOutboxUnavailableError()
  }
}
