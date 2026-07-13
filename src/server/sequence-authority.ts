export const MAX_SAFE_SEQUENCE = Number.MAX_SAFE_INTEGER
export const SEQUENCE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface SequenceRecord {
  seq: number
  updatedAt: number
}

export interface SequenceBump extends SequenceRecord {
  eventId: string
  duplicate: boolean
}

/**
 * Storage-independent consistency boundary.
 *
 * Every driver must provide tenant isolation, monotonic safe-integer versions,
 * idempotent bumps, and a durable invalidation event committed atomically with
 * the bump. Routes and peer logic depend only on this contract.
 */
export interface SequenceAuthority {
  read(resourceKey: string): Promise<SequenceRecord>
  bump(resourceKey: string, idempotencyKey: string): Promise<SequenceBump>
}

export type SequenceAuthorityProvider = () => SequenceAuthority

export class SequenceAuthorityUnavailableError extends Error {
  constructor() {
    super('sequence authority unavailable')
    this.name = 'SequenceAuthorityUnavailableError'
  }
}

export class SequenceAuthorityInputError extends Error {
  constructor() {
    super('invalid sequence authority input')
    this.name = 'SequenceAuthorityInputError'
  }
}

export function assertSequenceResourceKey(resourceKey: string): void {
  if (
    !resourceKey.startsWith('/api/') ||
    resourceKey.length > 2048 ||
    resourceKey.includes('//') ||
    /[\\?#\u0000-\u001f\u007f]/.test(resourceKey)
  ) {
    throw new SequenceAuthorityInputError()
  }
}

export function assertSequenceUuid(value: string): void {
  if (!SEQUENCE_UUID_PATTERN.test(value)) throw new SequenceAuthorityInputError()
}
