export function makePrng(seed: number): () => number {
  let state = seed >>> 0

  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

export function buildZipfTable(n: number, alpha = 1.0): Float64Array {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('buildZipfTable requires a positive integer item count')
  }
  if (!Number.isFinite(alpha) || alpha <= 0) {
    throw new Error('buildZipfTable requires alpha > 0')
  }

  let total = 0
  for (let rank = 1; rank <= n; rank++) {
    total += 1 / Math.pow(rank, alpha)
  }

  const table = new Float64Array(n)
  let cumulative = 0
  for (let rank = 1; rank <= n; rank++) {
    cumulative += (1 / Math.pow(rank, alpha)) / total
    table[rank - 1] = cumulative
  }
  table[n - 1] = 1

  return table
}

export function sampleZipf(table: Float64Array, rng: () => number): number {
  if (table.length === 0) {
    throw new Error('sampleZipf requires a non-empty CDF table')
  }

  const value = rng()
  for (let i = 0; i < table.length; i++) {
    if (value <= table[i]) {
      return i
    }
  }

  return table.length - 1
}

export function rankToKey(rank: number, prefix = '/api/products'): string {
  if (!Number.isInteger(rank) || rank < 0) {
    throw new Error('rankToKey requires rank >= 0')
  }

  return `${prefix}/${rank + 1}`
}
