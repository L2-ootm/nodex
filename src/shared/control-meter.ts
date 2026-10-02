/** Application-body observations only: HTTP/TLS/billing overhead is unknown. */
export interface ControlObservation {
  eventId: string
  operation: string
  startedAt: number
  durationMs: number
  status: number
  requestBytes: number
  responseBytes: number
  complete: boolean
}
const observations: ControlObservation[] = []
let discarded = 0
const LIMIT = 5000

export function controlSnapshot(since = 0) {
  return { scope: 'application-body' as const, discarded,
    observations: observations.filter(sample => sample.startedAt >= since).map(sample => ({ ...sample })) }
}

export async function meteredFetch(operation: string, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const startedAt = Date.now(), monotonicStart = performance.now()
  const label = operation.split('?')[0]!.split('/').slice(0, 2).join('/').slice(0, 80)
  const sample: ControlObservation = { eventId: crypto.randomUUID(), operation: label,
    startedAt, durationMs: 0, status: 0,
    requestBytes: typeof init?.body === 'string' ? new TextEncoder().encode(init.body).byteLength : 0,
    responseBytes: 0, complete: false }
  try {
    const response = await fetch(input, init)
    sample.status = response.status
    const reader = response.clone().body?.getReader()
    if (reader) {
      while (true) {
        const part = await reader.read()
        if (part.done) { sample.complete = true; break }
        sample.responseBytes += part.value.byteLength
        if (sample.responseBytes > 131_072) {
          void reader.cancel().catch(() => undefined)
          break
        }
      }
    } else sample.complete = true
    return response
  } finally {
    sample.durationMs = performance.now() - monotonicStart
    observations.push(sample)
    if (observations.length > LIMIT) { observations.shift(); discarded++ }
  }
}
