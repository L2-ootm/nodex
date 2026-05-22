// src/volatility/volatility.ts — Pure volatility heuristic functions (Phase 4, VOL-02)
// No DOM globals — safe to import in vitest Node.js environment and in Service Worker.
// All constants imported from config.ts; no hardcoded thresholds in this file.

import {
  VOL_ALPHA,
  VOL_BETA,
  VOL_GAMMA,
  VOL_P2P_GATE,
  VOL_TTL_STABLE_MS,
  VOL_TTL_VOLATILE_MS,
  VOL_TTL_EPHEMERAL_MS,
  VOL_DECAY_WINDOW_MS,
  VOL_CHANGE_BASELINE,
  VOL_ACCESS_BASELINE,
} from '../shared/config.js'
import type { VolatilityEntry } from '../shared/types.js'

/**
 * Compute a volatility score in [0, 1] for a given ledger entry.
 *
 * Formula:
 *   change_frequency  = min(change_count / VOL_CHANGE_BASELINE, 1)
 *   recency_decay     = 1 - min((now - last_changed_at) / VOL_DECAY_WINDOW_MS, 1)
 *   access_frequency  = min(access_count / VOL_ACCESS_BASELINE, 1)
 *   raw = ALPHA * change_frequency + BETA * recency_decay + GAMMA * (1 - access_frequency)
 *
 * Higher score = more volatile. Score of 0 = completely stable and heavily accessed.
 *
 * NOTE: The cold-start default of 0.5 (VOL_COLD_START) is NOT produced by this function.
 * That default is applied by the SW caller when no ledger entry exists for a key.
 * A zero-history entry (change_count=0, access_count=0, last_changed_at far in past)
 * produces raw = 0 + 0 + 0.3 * 1 = 0.3 (stable tier), which is correct behavior.
 *
 * @param entry - VolatilityEntry from the nodex-volatility IDB store
 * @param now   - Current epoch ms; defaults to Date.now(). Inject for deterministic tests.
 */
export function computeScore(entry: VolatilityEntry, now: number = Date.now()): number {
  const change_frequency = Math.min(entry.change_count / VOL_CHANGE_BASELINE, 1)
  const recency_decay = 1 - Math.min((now - entry.last_changed_at) / VOL_DECAY_WINDOW_MS, 1)
  const access_frequency = Math.min(entry.access_count / VOL_ACCESS_BASELINE, 1)

  const raw =
    VOL_ALPHA * change_frequency +
    VOL_BETA * recency_decay +
    VOL_GAMMA * (1 - access_frequency)

  return Math.max(0, Math.min(1, raw))
}

/**
 * Classify a volatility score into one of three tiers.
 *
 *   score < 0.4                            → 'stable'
 *   score >= 0.4 && score < VOL_P2P_GATE  → 'volatile'
 *   score >= VOL_P2P_GATE                  → 'ephemeral'
 *
 * @param score - Output of computeScore, in [0, 1]
 */
export function classifyTier(score: number): 'stable' | 'volatile' | 'ephemeral' {
  if (score >= VOL_P2P_GATE) return 'ephemeral'
  if (score >= 0.4) return 'volatile'
  return 'stable'
}

/**
 * Derive the cache TTL in milliseconds for a given volatility tier.
 *
 *   'stable'    → VOL_TTL_STABLE_MS   (300000ms = 5 min)
 *   'volatile'  → VOL_TTL_VOLATILE_MS (30000ms  = 30 sec)
 *   'ephemeral' → VOL_TTL_EPHEMERAL_MS (0ms      = no caching)
 *
 * @param tier - Output of classifyTier
 */
export function deriveTTL(tier: 'stable' | 'volatile' | 'ephemeral'): number {
  switch (tier) {
    case 'stable':    return VOL_TTL_STABLE_MS
    case 'volatile':  return VOL_TTL_VOLATILE_MS
    case 'ephemeral': return VOL_TTL_EPHEMERAL_MS
  }
}
