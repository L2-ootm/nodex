/** Bounded observer-local deduplication. Replay is allowed; double counting is not. */
export class MetricDeduplicator {
  private seen = new Set<string>()
  constructor(private readonly capacity = 5_000) {}
  accept(event: { event_id?: string }): boolean {
    if (!event.event_id) return true // Legacy metrics are not economic evidence.
    if (this.seen.has(event.event_id)) return false
    this.seen.add(event.event_id)
    while (this.seen.size > this.capacity) this.seen.delete(this.seen.values().next().value!)
    return true
  }
}
