export type JoinMode = 'sequential' | 'concurrent'

const supportedJoinModes = new Set<JoinMode>(['sequential', 'concurrent'])
const commitPattern = /^[0-9a-f]{7,64}$/i

function normalizeJoinMode(rawMode: string): JoinMode {
  const mode = rawMode.trim().toLowerCase()
  if (supportedJoinModes.has(mode as JoinMode)) return mode as JoinMode
  throw new Error(`invalid deployed join mode "${rawMode}"; expected sequential or concurrent`)
}

function modeFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--mode') {
      const next = args[i + 1]
      if (!next) throw new Error('missing value for --mode; expected sequential or concurrent')
      return next
    }
    if (arg.startsWith('--mode=')) return arg.slice('--mode='.length)
  }
  return undefined
}

function optionFromArgs(args: string[], option: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === option) {
      const next = args[i + 1]
      if (!next) throw new Error(`missing value for ${option}`)
      return next
    }
    if (arg.startsWith(`${option}=`)) return arg.slice(option.length + 1)
  }
  return undefined
}

function normalizeCommit(rawCommit: string, label: string): string {
  const commit = rawCommit.trim().toLowerCase()
  if (!commitPattern.test(commit)) {
    throw new Error(`${label} "${rawCommit}" is not a 7-64 character hexadecimal commit hash`)
  }
  return commit
}

function commitsMatch(expectedCommit: string, actualCommit: string): boolean {
  return expectedCommit.startsWith(actualCommit) || actualCommit.startsWith(expectedCommit)
}

export function resolveJoinMode(
  args: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): JoinMode {
  return normalizeJoinMode(modeFromArgs(args) ?? env['NODEX_DEPLOYED_JOIN_MODE'] ?? 'sequential')
}

export function resolveExpectedCommit(
  args: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  localCommit = '',
): string {
  const rawCommit =
    optionFromArgs(args, '--expected-commit') ??
    env['NODEX_DEPLOYED_EXPECTED_COMMIT'] ??
    localCommit

  if (!rawCommit?.trim()) {
    throw new Error(
      'expected deployed commit is required; use --expected-commit, NODEX_DEPLOYED_EXPECTED_COMMIT, or run from a Git checkout',
    )
  }

  return normalizeCommit(rawCommit, 'expected deployed commit')
}

export function assertMatchingDeploymentCommit(input: {
  expectedCommit: string
  appCommit: string
  apiCommit: string
}): void {
  const expectedCommit = normalizeCommit(input.expectedCommit, 'expected deployed commit')

  for (const [surface, rawCommit] of [
    ['app', input.appCommit],
    ['api', input.apiCommit],
  ] as const) {
    if (!rawCommit || rawCommit.trim().toLowerCase() === 'unknown') {
      throw new Error(`${surface} deployment commit is unavailable; refusing to produce hosted evidence`)
    }
    const actualCommit = normalizeCommit(rawCommit, `${surface} deployment commit`)
    if (!commitsMatch(expectedCommit, actualCommit)) {
      throw new Error(
        `${surface} deployment commit ${actualCommit} does not match expected ${expectedCommit}; refusing stale-alias evidence`,
      )
    }
  }
}

export async function openNodesForMode(
  mode: JoinMode,
  openNodeA: () => Promise<void>,
  openNodeB: () => Promise<void>,
  waitBetweenSequentialNodes: () => Promise<void>,
): Promise<void> {
  if (mode === 'concurrent') {
    await Promise.all([openNodeA(), openNodeB()])
    return
  }

  await openNodeA()
  await waitBetweenSequentialNodes()
  await openNodeB()
}
