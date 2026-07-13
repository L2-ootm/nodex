export type JoinMode = 'sequential' | 'concurrent'

const supportedJoinModes = new Set<JoinMode>(['sequential', 'concurrent'])

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

export function resolveJoinMode(
  args: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): JoinMode {
  return normalizeJoinMode(modeFromArgs(args) ?? env['NODEX_DEPLOYED_JOIN_MODE'] ?? 'sequential')
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
