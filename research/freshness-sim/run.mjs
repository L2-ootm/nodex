// Usage: node run.mjs [--seeds 5] [--scenario baseline] [--duration 300] [--out out] [--strict]
// Writes <out>/results.csv (one row per scenario x seed x arm) and <out>/summary.md.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ARMS, buildTrace, runArm, cost } from './sim.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const prereg = JSON.parse(readFileSync(join(here, 'prereg.json'), 'utf8'))
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i < 0 ? dflt : process.argv[i + 1] }
const seeds = Number(arg('seeds', 5))
const only = arg('scenario', null)
const outDir = join(here, arg('out', 'out'))
const strict = process.argv.includes('--strict')
const names = Object.keys(prereg.scenarios).filter(n => !only || n === only)
if (!names.length) { console.error('unknown scenario; known: ' + Object.keys(prereg.scenarios).join(', ')); process.exit(2) }

const rows = []
for (const scenario of names) {
  const p = { ...prereg.defaults, ...prereg.scenarios[scenario] }
  if (arg('duration', null)) p.durationMs = Number(arg('duration')) * 1000
  for (let seed = 1; seed <= seeds; seed++) {
    const trace = buildTrace(p, seed)
    for (const arm of ARMS) {
      const r = runArm(arm, p, trace, seed)
      rows.push({ scenario, seed, arm, ...r, usd: cost(r, prereg.prices) })
    }
  }
}

// Derived per-reader-hour metrics used by the summary and by the hypothesis checks.
for (const r of rows) {
  r.originReqsPerRh = r.originReqs / r.readerHours
  r.billedMiBPerRh = r.billedBytes / 2 ** 20 / r.readerHours
  r.peerMiBPerRh = (r.peerPayloadBytes + r.peerControlBytes) / 2 ** 20 / r.readerHours
  r.usdPer1kRh = r.usd / r.readerHours * 1000
  r.stalePct = 100 * r.staleReads / r.reads
  r.meanStaleMs = r.sumStaleMs / r.reads
  r.infraPayloadPct = 100 * (r.pathOrigin + r.pathEdge) / r.reads
}

const cols = ['scenario', 'seed', 'arm', 'reads', 'readerHours', 'pathLocal', 'pathReval', 'pathPeer', 'pathEdge', 'pathOrigin',
  'originReqs', 'edgeReqs', 'originBytes', 'edgeBytes', 'billedBytes', 'peerPayloadBytes', 'peerControlBytes', 'proofRenewals',
  'peerAttempts', 'peerRejects', 'signalingPolls', 'staleReads', 'violations', 'monoViolations', 'maxStaleMs', 'meanStaleMs',
  'staleP99Ms', 'latP50', 'latP95', 'latP99', 'usd', 'usdPer1kRh']
const fmt = v => typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(4) : String(v)
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'results.csv'), [cols.join(','), ...rows.map(r => cols.map(c => fmt(r[c])).join(','))].join('\n') + '\n')

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length
const sel = (scenario, arm) => rows.filter(r => r.scenario === scenario && r.arm === arm)
const pad = (s, n) => String(s).padEnd(n)
const lpad = (s, n) => String(s).padStart(n)
let md = `# Simulated comparison (model output, not measurement)\n\nSeeds per scenario: ${seeds}. Prices are hypothetical (prereg.json). Values are means over seeds unless noted.\n`
for (const scenario of names) {
  const p = { ...prereg.defaults, ...prereg.scenarios[scenario] }
  md += `\n## ${scenario}\n\n${JSON.stringify(prereg.scenarios[scenario])} | readers=${p.readers} keys=${p.keys} payload=${p.payloadBytes}B write~${p.writeMeanMs}ms session~${p.sessionMeanMs}ms\n\n`
  md += '```\n' + pad('arm', 16) + ['originReq/rh', 'billedMiB/rh', 'peerMiB/rh', '$/1k rh', 'stale%', 'maxStale ms', 'viol>d+e', 'mono', 'p50 ms', 'p95 ms', 'infraPayload%']
    .map(h => lpad(h, 14)).join('') + '\n'
  for (const arm of ARMS) {
    const s = sel(scenario, arm)
    const a = k => mean(s.map(r => r[k]))
    md += pad(arm, 16) + [a('originReqsPerRh').toFixed(1), a('billedMiBPerRh').toFixed(2), a('peerMiBPerRh').toFixed(2), a('usdPer1kRh').toFixed(3),
      a('stalePct').toFixed(2), Math.max(...s.map(r => r.maxStaleMs)).toFixed(0), s.reduce((n, r) => n + r.violations, 0),
      s.reduce((n, r) => n + r.monoViolations, 0), a('latP50').toFixed(0), a('latP95').toFixed(0), a('infraPayloadPct').toFixed(1)]
      .map(v => lpad(v, 14)).join('') + '\n'
  }
  md += '```\n'
}

// Pre-registered checks. Every check must hold on EVERY seed of EVERY listed scenario.
md += '\n## Pre-registered hypothesis checks\n\n```\n'
let failed = 0
for (const h of prereg.hypotheses) {
  const scen = h.scenarios.filter(s => names.includes(s))
  if (!scen.length) { md += `SKIP ${h.id}  (scenario not run)\n`; continue }
  let ok = true, worst = null
  for (const s of scen) for (let seed = 1; seed <= seeds; seed++) {
    const get = (arm, metric) => rows.find(r => r.scenario === s && r.seed === seed && r.arm === arm)[metric]
    let val, pass
    if (h.type === 'zero') { val = get(h.arm, h.metric); pass = val === 0 }
    else if (h.type === 'positive') { val = get(h.arm, h.metric); pass = val > 0 }
    else if (h.type === 'max') { val = get(h.arm, h.metric); pass = val <= h.max }
    else { val = get(h.arm, h.metric) / get(h.vs, h.metric); pass = h.type === 'ratio_le' ? val <= h.max : val >= h.min }
    if (!pass) ok = false
    const badness = h.type === 'ratio_ge' || h.type === 'positive' ? -val : val
    if (worst === null || badness > worst.badness) worst = { badness, val, s, seed }
  }
  if (!ok && !h.exploratory) failed++
  md += `${h.exploratory ? 'EXPLORATORY ' : ''}${ok ? 'PASS' : 'FAIL'} ${h.id}  ${h.text}\n     worst seed: ${Number(worst.val.toFixed(4))} (${worst.s}, seed ${worst.seed})\n`
}
md += '```\n'
writeFileSync(join(outDir, 'summary.md'), md)
console.log(md)
console.log(`wrote ${join(outDir, 'results.csv')} (${rows.length} rows) and summary.md`)
if (strict && failed) process.exit(1)
