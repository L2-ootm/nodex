// node test.mjs  -- asserts that the harness is deterministic and that its violation oracle can fail.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ARMS, buildTrace, runArm } from './sim.mjs'

const prereg = JSON.parse(readFileSync(new URL('./prereg.json', import.meta.url), 'utf8'))
const scenario = name => ({ ...prereg.defaults, ...prereg.scenarios[name], durationMs: 120000 })
const run = (name, arm, seed, opt) => { const p = scenario(name); return runArm(arm, p, buildTrace(p, seed), seed, opt) }

// 1. Determinism: same seed gives byte-identical metrics; a different seed does not.
for (const arm of ARMS) assert.deepEqual(run('adversarial', arm, 7), run('adversarial', arm, 7), arm + ' not deterministic')
assert.notDeepEqual(run('baseline', 'nodex-detached', 1), run('baseline', 'nodex-detached', 2))

// 2. Paired workload: every arm answers exactly the same reads.
const reads = ARMS.map(arm => run('baseline', arm, 3).reads)
assert.ok(reads.every(n => n === reads[0] && n > 0), 'arms saw different workloads')

// 3. Ground truth sanity: the origin is never stale; a TTL cache is stale but inside the bound.
assert.equal(run('hot-writes', 'origin-only', 1).staleReads, 0)
const ttl = run('hot-writes', 'browser-ttl', 1)
assert.ok(ttl.staleReads > 0 && ttl.maxStaleMs <= 5000 && ttl.violations === 0)

// 4. The safety claim, and the mutations that must break it.
for (const seed of [1, 2, 3]) {
  const safe = run('clock-replay', 'nodex-detached', seed)
  assert.equal(safe.violations, 0); assert.equal(safe.monoViolations, 0)
  assert.ok(safe.maxStaleMs <= 5000 + 50 + 1, 'calibrated bound is delta + calibration error')
  assert.equal(run('clock-replay', 'nodex-coupled', seed, { calibrate: true }).violations, 0, 'calibration alone fixes the coded design')
}
const sum = (arm, opt) => [1, 2, 3].reduce((n, seed) => n + run('clock-replay', arm, seed, opt).violations, 0)
assert.ok(sum('nodex-coupled') > 0, 'raw clock + replay must violate')
assert.ok(sum('nodex-detached', { calibrate: false }) > 0, 'detached without calibration must violate')
assert.ok(sum('nodex-coupled', { calibrate: true, checkProof: false }) > 0, 'removing the validity window must violate')
assert.ok(sum('p2p-gossip') > 0, 'unsigned gossip cache must violate')

console.log('ok: deterministic, paired, oracle detects 4 seeded mutations, safety holds on clock-replay seeds 1-3')
