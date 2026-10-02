import { expect, it } from 'vitest'
import { MetricDeduplicator } from './metric-dedup.js'

it('counts live plus replay as one logical event, while keeping observers independent', () => {
  const first = new MetricDeduplicator(2)
  const second = new MetricDeduplicator(2)
  expect(first.accept({ event_id: 'read-a' })).toBe(true)
  expect(first.accept({ event_id: 'read-a' })).toBe(false)
  expect(second.accept({ event_id: 'read-a' })).toBe(true)
  expect(first.accept({ event_id: 'read-b' })).toBe(true)
  expect(first.accept({ event_id: 'read-c' })).toBe(true)
  expect(first.accept({ event_id: 'read-a' })).toBe(true)
})
