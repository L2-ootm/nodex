import { describe, expect, it } from 'vitest'
import {
  assertMatchingDeploymentCommit,
  openNodesForMode,
  resolveExpectedCommit,
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

  it('resolves expected commit from CLI, environment, then local git fallback', () => {
    expect(resolveExpectedCommit(
      ['--expected-commit=abc1234'],
      { NODEX_DEPLOYED_EXPECTED_COMMIT: 'def5678' },
      'fedcba9',
    )).toBe('abc1234')
    expect(resolveExpectedCommit(
      [],
      { NODEX_DEPLOYED_EXPECTED_COMMIT: 'def5678' },
      'fedcba9',
    )).toBe('def5678')
    expect(resolveExpectedCommit([], {}, 'fedcba9')).toBe('fedcba9')
  })

  it('requires an expected commit before browser launch', () => {
    expect(() => resolveExpectedCommit([], {}, '')).toThrow(/expected deployed commit is required/i)
  })

  it('accepts short and full hashes from the same deployment commit', () => {
    expect(() => assertMatchingDeploymentCommit({
      expectedCommit: 'abc1234',
      appCommit: 'abc1234',
      apiCommit: 'abc1234def567890abc1234def567890abc1234d',
    })).not.toThrow()
  })

  it('rejects missing or mismatched deployment identities', () => {
    expect(() => assertMatchingDeploymentCommit({
      expectedCommit: 'abc1234',
      appCommit: 'unknown',
      apiCommit: 'abc1234def567890abc1234def567890abc1234d',
    })).toThrow(/app deployment commit is unavailable/i)

    expect(() => assertMatchingDeploymentCommit({
      expectedCommit: 'abc1234',
      appCommit: 'abc1234',
      apiCommit: 'deadbeef',
    })).toThrow(/api deployment commit deadbeef does not match expected abc1234/i)
  })
})
