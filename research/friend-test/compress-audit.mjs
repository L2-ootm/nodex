// Byte audit: what does one payload delivery cost on the wire for (a) a CDN that compresses JSON and
// (b) Nodex as shipped (AES-GCM ciphertext, base64 body, cannot be compressed by any edge)?
// And what share of payload deliveries must come from peers before Nodex bills fewer bytes than the CDN?
//
//   node compress-audit.mjs                 synthetic snapshots (catalog-like and number-heavy), 1 KiB to 1 MiB
//   node compress-audit.mjs --file real.json   one real snapshot from a candidate workload (the run that counts)
//
// Nodex wire model = fixed overhead + base64(plaintext + 16-byte GCM tag). Calibrated against the repo's own
// measurement (research/NODEX_CLAIM_AND_PREREGISTRATION.md:18: 1,506 B at 256 B, 2,530 at 1 KiB, 83,086 at 60 KiB).
// Simulator reference (RESULTS-30-seeds.md baseline): payload-carrying infrastructure reads are 7.6 % for the
// TTL CDN and 2.4 % for nodex-shipped, i.e. peers carry 1 - 2.4/7.6 = 68 % of payload deliveries in the model.
import { brotliCompressSync, gzipSync, constants } from 'node:zlib'
import { readFileSync } from 'node:fs'

const OVERHEAD = 1146 // bytes; fitted so the model reproduces the three measured points within 10 bytes
const nodexWire = plainBytes => OVERHEAD + 4 * Math.ceil((plainBytes + 16) / 3)
for (const [plain, measured] of [[256, 1506], [1024, 2530], [61440, 83086]]) {
  if (Math.abs(nodexWire(plain) - measured) > 10) throw new Error(`wire model drifted from the measured ${measured} B at ${plain} B`)
}
const SIM_PEER_SHARE = 1 - 2.4 / 7.6
const HTTP_HEADERS = 400 // a compressed CDN response still carries headers; generous to Nodex

const words = 'alpha bravo cedar delta ember frost grove harbor iris juniper kestrel lumen maple nectar onyx prairie quartz river summit tundra umber valley willow xenon yarrow zephyr'.split(' ')
let seed = 42
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
const pick = () => words[Math.floor(rnd() * words.length)]
function catalog(bytes) { // names, categories, prices, timestamps, URLs: typical public board or listing
  const items = []
  while (JSON.stringify(items).length < bytes) items.push({ id: 'p-' + (100000 + items.length), name: `${pick()} ${pick()} ${pick()}`, category: pick(),
    price: +(rnd() * 500).toFixed(2), currency: 'BRL', inStock: rnd() > 0.2, updatedAt: new Date(1.79e12 + items.length * 977).toISOString(),
    url: `https://example.test/products/${pick()}-${pick()}-${items.length}`, rating: +(3 + rnd() * 2).toFixed(1) })
  return JSON.stringify({ version: 1, items })
}
function numbers(bytes) { // order-book style: almost all high-entropy digits, the worst case for a compressor
  const rows = []
  while (JSON.stringify(rows).length < bytes) rows.push([+(rnd() * 100000).toFixed(4), +(rnd() * 1000).toFixed(6), Math.floor(rnd() * 1e9)])
  return JSON.stringify({ rows })
}

const fmt = n => n.toLocaleString('en-US').padStart(10)
function audit(label, text) {
  const plain = Buffer.byteLength(text)
  const br = brotliCompressSync(text, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).length + HTTP_HEADERS // typical on-the-fly edge quality
  const gz = gzipSync(text, { level: 6 }).length + HTTP_HEADERS
  const shipped = nodexWire(plain)
  const fixed = nodexWire(gzipSync(text, { level: 6 }).length) // compress, then encrypt (not implemented)
  const breakEven = wire => Math.max(0, 1 - br / wire)
  const ratio = wire => (1 - SIM_PEER_SHARE) * wire / br // Nodex billed payload bytes / CDN billed payload bytes at the simulator's peer share
  console.log(`${label.padEnd(22)}${fmt(plain)}${fmt(br)}${fmt(gz)}${fmt(shipped)}${(shipped / br).toFixed(2).padStart(8)}x` +
    `${(breakEven(shipped) * 100).toFixed(0).padStart(8)} %${ratio(shipped).toFixed(2).padStart(9)}${fmt(fixed)}${ratio(fixed).toFixed(2).padStart(9)}`)
  return { plain, br, shipped, fixed, ratioShipped: ratio(shipped), ratioFixed: ratio(fixed) }
}

console.log('payload                    plain  CDN brotli  CDN gzip  Nodex wire  vs CDN  break-even  billed   Nodex if   billed')
console.log('                               B           B         B     shipped           peer share  ratio*   gz+AES B   ratio*')
const file = process.argv.indexOf('--file') > 0 ? process.argv[process.argv.indexOf('--file') + 1] : null
if (file) audit('file', readFileSync(file, 'utf8'))
else for (const kib of [1, 8, 32, 60, 256, 1024]) {
  audit(`catalog ${kib} KiB`, catalog(kib * 1024))
  audit(`numbers ${kib} KiB`, numbers(kib * 1024))
}
console.log(`\n* billed ratio = Nodex billed payload bytes / compressing-CDN billed payload bytes, granting the simulator's ${(SIM_PEER_SHARE * 100).toFixed(0)} % peer share.`)
console.log('  Above 1.00 Nodex bills MORE than the CDN. The preregistered H2 threshold is 0.40 against an uncompressed baseline.')
console.log('  "break-even peer share": peers must carry at least this share of payload deliveries for Nodex to tie the CDN.')
console.log('  Proof renewals (839 B each) and signaling are extra on the Nodex side and are not counted here.')
