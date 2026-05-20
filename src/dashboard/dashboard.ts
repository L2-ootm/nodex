// src/dashboard/dashboard.ts — Phase 1 stub
// Registers /sw.js, updates #status div, wires fetch button.
// Full metrics dashboard (BroadcastChannel, charts, peer counters) in Plan 03.

const statusEl = document.getElementById('status') as HTMLDivElement
const logEl = document.getElementById('log') as HTMLDivElement
const fetchBtn = document.getElementById('fetch-btn') as HTMLButtonElement

function appendLog(msg: string): void {
  logEl.textContent = `${new Date().toISOString()} ${msg}\n` + logEl.textContent
}

// Service Worker registration
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then((reg) => {
      appendLog(`SW registered: scope=${reg.scope}`)
    })
    .catch((err) => {
      appendLog(`SW registration failed: ${err}`)
    })

  navigator.serviceWorker.ready.then(() => {
    statusEl.textContent = 'SW: active'
    statusEl.classList.add('active')
  })
} else {
  statusEl.textContent = 'SW: not supported'
  appendLog('Service Workers not supported in this browser.')
}

// Fetch button — triggers a GET /api/products/1 to exercise the SW cache path
fetchBtn.addEventListener('click', () => {
  const url = '/api/products/1'
  appendLog(`Fetching ${url} ...`)

  fetch(url)
    .then((res) => {
      const seq = res.headers.get('X-Nodex-Seq') ?? 'n/a'
      appendLog(`Response: status=${res.status} X-Nodex-Seq=${seq}`)
      return res.json()
    })
    .then((data: unknown) => {
      appendLog(`Body: ${JSON.stringify(data)}`)
    })
    .catch((err: unknown) => {
      appendLog(`Fetch error: ${String(err)}`)
    })
})
