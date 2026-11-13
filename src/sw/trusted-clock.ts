// Reader-side freshness reference. Wall-clock Date.now() is attacker- and user-controlled
// (skew, NTP steps, resume), so freshness windows are judged against server time carried by a
// publisher-signed proof from a fresh origin response, advanced with the monotonic clock.
// Only the origin no-store path may anchor; peers, signaling and cached entries never do.
// shortcut: in-memory only, lost on Service Worker restart (falls back to Date.now()); persist if
// restarts are shown to cause avoidable origin fetches.
let anchor: { serverMs: number; perfMs: number } | null = null

export function trustedNow(): number {
  return anchor ? anchor.serverMs + (performance.now() - anchor.perfMs) : Date.now()
}

export function hasTrustedAnchor(): boolean { return anchor !== null }

/** Never moves trusted time backward, so an older signed proof cannot rewind the clock. */
export function anchorTrustedClock(serverMs: number): void {
  if (!Number.isFinite(serverMs) || serverMs <= 0) return
  if (anchor && serverMs < trustedNow()) return
  anchor = { serverMs, perfMs: performance.now() }
}

export function _resetTrustedClockForTest(): void { anchor = null }
