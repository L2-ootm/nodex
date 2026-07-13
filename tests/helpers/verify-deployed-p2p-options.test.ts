import { describe, expect, it } from 'vitest'
import {
  openNodesForMode,
  resolveJoinMode,
  type JoinMode,
} from '../../scripts/verify-deployed-p2p-options.js'

describe('verify deployed P2P smoke options', () => {
  it('defaults to sequential mode when no option is provided', () => {
    expect(resolveJoinMode([], {})).toBe('sequential')
  })

  it('uses NODEX_DEPLOYED_JOIN_MODE from the environment', () => {
    expect(resolveJoinMode([], { NODEX_DEPLOYED_JOIN_MODE: 'concurrent' })).toBe('concurrent')
  })

  it('lets the CLI --mode flag override the environment', () => {
    expect(resolveJoinMode(['--mode=sequential'], { NODEX_DEPLOYED_JOIN_MODE: 'concurrent' })).toBe('sequential')
    expect(resolveJoinMode(['--mode', 'concurrent'], { NODEX_DEPLOYED_JOIN_MODE: 'sequential' })).toBe('concurrent')
  })

  it('rejects invalid join modes before browser launch', () => {
    expect(() => resolveJoinMode(['--mode=parallel'], {})).toThrow(/invalid deployed join mode "parallel"/i)
  })

  it('rejects --mode without a value before browser launch', () => {
    expect(() => resolveJoinMode(['--mode'], {})).toThrow(/missing value for --mode/i)
  })

  it('preserves ordered launch in sequential mode', async () => {
    const events: string[] = []

    await openNodesForMode(
      'sequential',
      async () => { events.push('open-a') },
      async () => { events.push('open-b') },
      async () => { events.push('sleep') },
    )

    expect(events).toEqual(['open-a', 'sleep', 'open-b'])
  })

  it('launches both nodes without the ordering sleep in concurrent mode', async () => {
    const events: string[] = []

    await openNodesForMode(
      'concurrent',
      async () => { events.push('open-a') },
      async () => { events.push('open-b') },
      async () => { events.push('sleep') },
    )

    expect(events.sort()).toEqual(['open-a', 'open-b'])
    expect(events).not.toContain('sleep')
  })

  it('accepts only the supported join mode literals', () => {
    const modes: JoinMode[] = ['sequential', 'concurrent']
    expect(modes.map((mode) => resolveJoinMode([`--mode=${mode}`], {}))).toEqual(modes)
  })
})
