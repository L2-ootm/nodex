import {
  assertSequenceResourceKey,
  assertSequenceUuid,
  MAX_SAFE_SEQUENCE,
  SequenceAuthorityInputError,
  SequenceAuthorityUnavailableError,
  type SequenceAuthority,
  type SequenceBump,
  type SequenceRecord,
} from './sequence-authority'

interface CommandRecord {
  resourceKey: string
  bump: SequenceBump
}

export interface InMemoryOutboxRecord extends SequenceBump {
  tenantId: string
  resourceKey: string
  availableAt: number
  attempts: number
  lockedBy?: string
  lockedUntil?: number
  deliveredAt?: number
  lastError?: string
}

export interface InMemorySequenceState {
  heads: Map<string, SequenceRecord>
  commands: Map<string, CommandRecord>
  outbox: Map<string, InMemoryOutboxRecord>
}

export function createInMemorySequenceState(): InMemorySequenceState {
  return { heads: new Map(), commands: new Map(), outbox: new Map() }
}

/**
 * Deterministic reference driver for conformance tests and simulation only.
 * It is process-local and therefore cannot provide production durability.
 */
export class InMemorySequenceAuthority implements SequenceAuthority {
  constructor(
    private readonly tenantId: string,
    private readonly state: InMemorySequenceState = createInMemorySequenceState(),
    private readonly now: () => number = Date.now,
  ) {
    assertSequenceUuid(tenantId)
  }

  async read(resourceKey: string): Promise<SequenceRecord> {
    assertSequenceResourceKey(resourceKey)
    const record = this.state.heads.get(this.headKey(resourceKey))
    if (!record) throw new SequenceAuthorityUnavailableError()
    return { ...record }
  }

  async bump(resourceKey: string, idempotencyKey: string): Promise<SequenceBump> {
    assertSequenceResourceKey(resourceKey)
    assertSequenceUuid(idempotencyKey)
    const commandKey = `${this.tenantId}:${idempotencyKey}`
    const existing = this.state.commands.get(commandKey)
    if (existing) {
      if (existing.resourceKey !== resourceKey) throw new SequenceAuthorityInputError()
      return { ...existing.bump, duplicate: true }
    }

    const headKey = this.headKey(resourceKey)
    const previous = this.state.heads.get(headKey)
    if (previous?.seq === MAX_SAFE_SEQUENCE) throw new SequenceAuthorityUnavailableError()
    const updatedAt = this.now()
    if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) throw new SequenceAuthorityUnavailableError()
    const bump: SequenceBump = {
      seq: previous ? previous.seq + 1 : 1,
      updatedAt,
      eventId: idempotencyKey,
      duplicate: false,
    }

    // No await occurs inside this mutation block. A JavaScript process observes
    // head, command, and outbox as one deterministic transition.
    this.state.heads.set(headKey, { seq: bump.seq, updatedAt })
    this.state.commands.set(commandKey, { resourceKey, bump })
    this.state.outbox.set(commandKey, {
      ...bump,
      tenantId: this.tenantId,
      resourceKey,
      availableAt: updatedAt,
      attempts: 0,
    })
    return { ...bump }
  }

  private headKey(resourceKey: string): string {
    return `${this.tenantId}:${resourceKey}`
  }
}
