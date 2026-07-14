import {
  assertInvalidationEvent,
  assertOutboxClaim,
  assertOutboxRetry,
  assertOutboxWorkerId,
  type InvalidationEvent,
  type InvalidationOutbox,
} from './invalidation-outbox.js'
import type { InMemorySequenceState } from './in-memory-sequence-authority.js'
import { assertSequenceUuid } from './sequence-authority.js'

/** Deterministic conformance reference for simulations and tests only. */
export class InMemoryInvalidationOutbox implements InvalidationOutbox {
  constructor(
    private readonly tenantId: string,
    private readonly state: InMemorySequenceState,
    private readonly now: () => number = Date.now,
  ) {
    assertSequenceUuid(tenantId)
  }

  async claim(workerId: string, limit: number, leaseMs: number): Promise<InvalidationEvent[]> {
    assertOutboxWorkerId(workerId)
    assertOutboxClaim(limit, leaseMs)
    const now = this.now()
    const candidates = [...this.state.outbox.values()]
      .filter((event) => (
        event.tenantId === this.tenantId &&
        event.deliveredAt === undefined &&
        event.availableAt <= now &&
        (event.lockedUntil === undefined || event.lockedUntil <= now)
      ))
      .sort((a, b) => a.availableAt - b.availableAt || a.eventId.localeCompare(b.eventId))
      .slice(0, limit)

    return candidates.map((event) => {
      event.lockedBy = workerId
      event.lockedUntil = now + leaseMs
      event.attempts++
      const claimed: InvalidationEvent = {
        tenantId: event.tenantId,
        eventId: event.eventId,
        resourceKey: event.resourceKey,
        seq: event.seq,
        updatedAt: event.updatedAt,
        attempts: event.attempts,
      }
      assertInvalidationEvent(claimed)
      return claimed
    })
  }

  async acknowledge(eventId: string, workerId: string): Promise<boolean> {
    assertSequenceUuid(eventId)
    assertOutboxWorkerId(workerId)
    const event = this.state.outbox.get(`${this.tenantId}:${eventId}`)
    if (!event || event.deliveredAt !== undefined || event.lockedBy !== workerId) return false
    event.deliveredAt = this.now()
    event.lockedBy = undefined
    event.lockedUntil = undefined
    event.lastError = undefined
    return true
  }

  async retry(eventId: string, workerId: string, delayMs: number, error: string): Promise<boolean> {
    assertSequenceUuid(eventId)
    assertOutboxWorkerId(workerId)
    assertOutboxRetry(delayMs, error)
    const event = this.state.outbox.get(`${this.tenantId}:${eventId}`)
    if (!event || event.deliveredAt !== undefined || event.lockedBy !== workerId) return false
    event.availableAt = this.now() + delayMs
    event.lockedBy = undefined
    event.lockedUntil = undefined
    event.lastError = error
    return true
  }
}
