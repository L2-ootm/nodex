import { expect, test } from '@playwright/test'

test('tester completes routed Next beta flow and profile cache excludes note', async ({ page }) => {
  await page.route('**/api/beta/auth', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        role: 'tester',
        tokenPreview: 'playwright...oken',
        invite: {
          assignedName: 'Playwright Tester',
          assignedEmail: 'playwright@example.test',
          welcomeNote: 'This invite is reserved for your browser flow test.',
          maxSessions: 1,
        },
      }),
    })
  })

  await page.route('**/api/beta/sessions', async (route) => {
    const request = route.request()
    expect(request.headers()['authorization']).toBe('Bearer playwright-token')
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        participantId: 'beta-playwright',
        sessionToken: 'beta-session-playwright',
        roomId: 'beta-room-playwright',
        testUrl: 'http://localhost:4173/?nodexRoom=beta-room-playwright',
      }),
    })
  })

  await page.route('**/api/beta/evidence', async (route) => {
    const request = route.request()
    expect(request.headers()['authorization']).toBe('Bearer beta-session-playwright')
    const body = request.postDataJSON() as {
      participantId: string
      roomId: string
      topologyLabel: string
      result: string
      lifecycleSignals: Array<{ type: string; visibilityState?: string }>
      deviceHints: { userAgent?: string; viewport?: { width: number; height: number } }
      telemetry: unknown[]
    }
    expect(body.participantId).toBe('beta-playwright')
    expect(body.roomId).toBe('beta-room-playwright')
    expect(body.topologyLabel).toBe('same-machine-isolation')
    expect(body.result).toBe('pass')
    expect(body.lifecycleSignals.some((signal) => signal.type === 'run-start')).toBe(true)
    expect(body.lifecycleSignals.some((signal) => signal.type === 'protocol-complete')).toBe(true)
    expect(body.deviceHints.userAgent).toContain('Mozilla')
    expect(body.deviceHints.viewport?.width).toBeGreaterThan(0)
    expect(body.telemetry).toEqual([{ connection_state: 'connected', peer_id: 'peer-a' }])
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ evidenceId: 'evidence-playwright' }),
    })
  })

  await page.route('**/api/beta/logs', async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ logId: 'log-playwright' }),
    })
  })

  await page.route('**/api/beta/rooms', async (route) => {
    expect(route.request().headers()['authorization']).toBe('Bearer playwright-token')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        rooms: [{
          runId: 'run-duo-playwright',
          roomId: 'beta-room-duo',
          title: 'Davi + Playwright',
          scenario: 'coordinator-duo',
          dataType: 'product-catalog',
          nodeCount: 2,
          status: 'ready',
          createdAt: new Date().toISOString(),
        }],
      }),
    })
  })

  await page.route('**/api/beta/presence', async (route) => {
    const request = route.request()
    expect(request.headers()['authorization']).toBe('Bearer playwright-token')
    expect(request.headers()['content-type']).toContain('application/json')
    const body = request.postDataJSON() as { name: string; roomId: string; participantId: string; mode: string }
    expect(body.name).toBe('Playwright Tester')
    expect(body.participantId).toBe('beta-playwright')
    const online = body.roomId === 'beta-room-duo'
      ? [
          { name: 'Davi', role: 'admin', mode: body.mode, participantId: 'coordinator-davi', roomId: body.roomId, lastSeen: new Date().toISOString() },
          { name: 'Playwright Tester', role: 'tester', mode: body.mode, participantId: 'beta-playwright', roomId: body.roomId, lastSeen: new Date().toISOString() },
        ]
      : [
          { name: 'Playwright Tester', role: 'tester', mode: body.mode, participantId: 'beta-playwright', roomId: body.roomId, lastSeen: new Date().toISOString() },
        ]
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ online }),
    })
  })

  await page.route('**/metrics.html?**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><body><script>
        window.__peerManagerReady = true;
        window.__peerConnections = new Map([['peer-a', { state: 'connected' }]]);
        window.__nodexPeerTelemetry = async () => [{ connection_state: 'connected', peer_id: 'peer-a' }];
        window.__nodexRuntimeConfig = () => ({ signalingUrl: 'mock-http-signal' });
        window.__nodexLastP2PCapture = () => ({ key: '/api/products/1', seq: 1, ivB64: 'mock-iv', ctSample: 'mock-ciphertext' });
        const ch = new BroadcastChannel('nodex-metrics');
        setTimeout(() => {
          ch.postMessage({ type: 'server-fallback', key: '/api/products/1' });
          ch.postMessage({ type: 'peer-fetch', key: '/api/products/1' });
          ch.postMessage({ type: 'gossip-propagation', key: '/api/products/1' });
        }, 50);
      </script></body></html>`,
    })
  })

  await page.route('**/api/products/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      headers: {
        'X-Nodex-Seq': '1',
        'X-Nodex-Iv': 'mock-iv',
        'X-Nodex-Key-Id': 'default',
      },
      body: 'mock-ciphertext',
    })
  })

  await page.route('**/api/invalidate/products/1', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ seq: 2 }) })
  })

  await page.route('**/api/signal/gossip-seed', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ seeded: true }) })
  })

  await page.goto('/')
  await page.getByLabel('Invitation token').fill('playwright-token')
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page).toHaveURL(/\/setup$/)
  await expect(page.getByText('This invite is reserved for your browser flow test.')).toBeVisible()
  await page.getByRole('link', { name: 'Start setup' }).click()

  await expect(page).toHaveURL(/\/profile$/)
  await expect(page.getByLabel('Name')).toHaveValue('Playwright Tester')
  await expect(page.getByLabel('Email')).toHaveValue('playwright@example.test')
  await page.getByLabel('City').fill('Sao Paulo')
  await page.getByLabel('Country').fill('BR')
  await page.getByLabel('Network').fill('local test')
  await page.getByLabel('Contribution note').fill('Do not cache this note.')
  await page.getByLabel('Consent to be credited').check()
  await page.getByRole('button', { name: 'Save profile and continue' }).click()

  await expect(page).toHaveURL(/\/room$/)
  await expect(page.getByRole('heading', { name: 'beta-room-playwright' })).toBeVisible()
  await page.reload()
  await page.getByRole('link', { name: 'Profile', exact: true }).click()
  await expect(page.getByLabel('City')).toHaveValue('Sao Paulo')
  await expect(page.getByLabel('Contribution note')).toHaveValue('')
  await page.getByRole('link', { name: 'Room', exact: true }).click()
  await page.getByRole('button', { name: 'Open solo room' }).click()
  await expect(page.getByText('Browser checks')).toBeVisible()
  await expect(page.getByText('WebRTC', { exact: true })).toBeVisible()
  await expect(page.locator('text', { hasText: 'Origin DB' })).toBeVisible()
  await expect(page.locator('text', { hasText: 'Playwright' })).toBeVisible()
  await expect(page.locator('.mesh-status strong')).toContainText(/visible|presence/)
  await page.getByRole('button', { name: 'Coordinator + tester' }).click()
  await expect(page.getByRole('button', { name: /Davi \+ Playwright/ })).toBeVisible()
  await page.getByRole('button', { name: 'Join selected room' }).click()
  await expect(page.locator('text', { hasText: 'Davi' })).toBeVisible()
  await expect(page.locator('.mesh-status strong')).toContainText(/ready|waiting/)
  await page.getByRole('button', { name: 'Run guided test' }).click()

  await expect(page).toHaveURL(/\/run$/)
  await page.getByRole('button', { name: 'Run real protocol test' }).click()
  await expect(page.getByText('Evidence bundle prepared')).toHaveClass(/done/, { timeout: 5000 })
  await expect(page.getByText(/P2P data transfer observed/)).toBeVisible()
  await page.getByRole('button', { name: 'Continue to evidence' }).click()

  await expect(page).toHaveURL(/\/evidence$/)
  await page.getByLabel('Notes').fill('Connected on same LAN.')
  await page.getByRole('button', { name: 'Send evidence' }).click()
  await expect(page).toHaveURL(/\/receipt$/)
  await expect(page.getByText('Evidence received.')).toBeVisible()
})

test('solo Next beta run auto-submits background-tab and mobile/browser lifecycle evidence', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('nodex-next-auth-v1', JSON.stringify({
      token: 'tester-token',
      role: 'tester',
      tokenPreview: 'tester...oken',
      invite: { assignedName: 'Solo Tester' },
    }))
    localStorage.setItem('nodex-next-session-v1', JSON.stringify({
      participantId: 'beta-solo',
      sessionToken: 'session-solo',
      roomId: 'solo-room',
      testUrl: 'http://localhost:4173/?nodexRoom=solo-room',
    }))
    localStorage.setItem('nodex-next-active-room-v1', JSON.stringify({ roomId: 'solo-room', mode: 'solo' }))
    localStorage.setItem('nodex-next-room-open-v1', '1')
  })

  await page.route('**/api/beta/auth', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ role: 'tester', tokenPreview: 'tester...oken', invite: { assignedName: 'Solo Tester' } }),
    })
  })
  await page.route('**/api/beta/rooms', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rooms: [] }) })
  })
  await page.route('**/metrics.html?**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><body><script>
        window.__peerManagerReady = true;
        window.__peerConnections = new Map();
        window.__nodexPeerTelemetry = async () => [{ connection_state: 'solo', selected_candidate_type: 'unknown' }];
        window.__nodexRuntimeConfig = () => ({ signalingUrl: 'mock-http-signal' });
        const ch = new BroadcastChannel('nodex-metrics');
        setTimeout(() => ch.postMessage({ type: 'server-fallback', key: '/api/products/1' }), 50);
      </script></body></html>`,
    })
  })
  await page.route('**/api/products/*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'X-Nodex-Seq': '1' }, body: 'mock-ciphertext' })
  })
  await page.route('**/api/invalidate/products/1', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ seq: 2 }) })
  })
  await page.route('**/api/signal/gossip-seed', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ seeded: true }) })
  })
  await page.route('**/api/beta/logs', async (route) => {
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ logId: 'log-solo' }) })
  })
  await page.route('**/api/beta/evidence', async (route) => {
    const body = route.request().postDataJSON() as {
      topologyLabel: string
      lifecycleSignals: Array<{ type: string; hidden?: boolean }>
      deviceHints: { userAgent?: string; mobile?: boolean; maxTouchPoints?: number }
      runtimeConfig: { nextSuite?: boolean; signalingUrl?: string }
    }
    expect(route.request().headers()['authorization']).toBe('Bearer session-solo')
    expect(body.topologyLabel).toBe('same-machine-isolation')
    expect(body.lifecycleSignals.map((signal) => signal.type)).toEqual(expect.arrayContaining(['run-start', 'protocol-complete']))
    expect(body.deviceHints.userAgent).toContain('Mozilla')
    expect(typeof body.deviceHints.mobile).toBe('boolean')
    expect(body.runtimeConfig.nextSuite).toBe(true)
    expect(body.runtimeConfig.signalingUrl).toBe('mock-http-signal')
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ evidenceId: 'evidence-solo' }) })
  })

  await page.goto('/run')
  await page.getByRole('button', { name: 'Run real protocol test' }).click()
  await expect(page.getByText('Evidence bundle prepared')).toHaveClass(/done/, { timeout: 5000 })
  await page.getByRole('button', { name: 'Continue to evidence' }).click()
  await expect(page.getByLabel('Topology')).toHaveValue('same-machine-isolation')
  await page.getByRole('button', { name: 'Send evidence' }).click()
  await expect(page).toHaveURL(/\/receipt$/)
})

test('tester session cannot see admin navigation or open admin routes', async ({ page }) => {
  const adminDataRequests: string[] = []
  await page.addInitScript(() => {
    localStorage.setItem('nodex-next-auth-v1', JSON.stringify({
      token: 'tester-token',
      role: 'tester',
      tokenPreview: 'tester...oken',
      invite: null,
    }))
  })

  await page.route('**/api/beta/auth', async (route) => {
    expect(route.request().headers()['authorization']).toBe('Bearer tester-token')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ role: 'tester', tokenPreview: 'tester...oken', invite: null }),
    })
  })

  page.on('request', (request) => {
    if (/\/api\/beta\/(tokens|runs|logs|audit|ledger|simulations)/.test(request.url())) {
      adminDataRequests.push(request.url())
    }
  })

  await page.goto('/admin/tokens')
  await expect(page).toHaveURL(/\/room$/)
  await expect(page.getByRole('link', { name: 'Tokens' })).toHaveCount(0)
  expect(adminDataRequests).toEqual([])
})

test('saved login revalidates and enters automatically without a continue button', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('nodex-next-auth-v1', JSON.stringify({
      token: 'admin-token',
      role: 'admin',
      tokenPreview: 'admin...oken',
      invite: null,
    }))
  })

  await page.route('**/api/beta/auth', async (route) => {
    expect(route.request().headers()['authorization']).toBe('Bearer admin-token')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ role: 'admin', tokenPreview: 'admin...oken', invite: null }),
    })
  })

  await page.goto('/')
  await expect(page.getByRole('button', { name: /Continue saved/i })).toHaveCount(0)
  await expect(page).toHaveURL(/\/admin$/)
})

test('tester sees an explicit empty room list for duo and group modes', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('nodex-next-auth-v1', JSON.stringify({
      token: 'tester-token',
      role: 'tester',
      tokenPreview: 'tester...oken',
      invite: { assignedName: 'Empty Room Tester' },
    }))
    localStorage.setItem('nodex-next-session-v1', JSON.stringify({
      participantId: 'beta-empty-room',
      sessionToken: 'session-empty-room',
      roomId: 'solo-empty-room',
      testUrl: 'http://localhost:4173/?nodexRoom=solo-empty-room',
    }))
  })

  await page.route('**/api/beta/auth', async (route) => {
    expect(route.request().headers()['authorization']).toBe('Bearer tester-token')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ role: 'tester', tokenPreview: 'tester...oken', invite: { assignedName: 'Empty Room Tester' } }),
    })
  })

  await page.route('**/api/beta/rooms', async (route) => {
    expect(route.request().headers()['authorization']).toBe('Bearer tester-token')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rooms: [] }),
    })
  })

  await page.goto('/room')
  await expect(page.getByText('Nenhuma sala encontrada.')).toHaveCount(0)
  await page.getByRole('button', { name: 'Coordinator + tester' }).click()
  await expect(page.getByText('Nenhuma sala encontrada.')).toBeVisible()
  await page.getByRole('button', { name: 'Group' }).click()
  await expect(page.getByText('Nenhuma sala encontrada.')).toBeVisible()
})

test('tester sees coordinator presence in a shared room before creating a session', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('nodex-next-auth-v1', JSON.stringify({
      token: 'tester-token',
      role: 'tester',
      tokenPreview: 'tester...oken',
      invite: { assignedName: 'Francisco' },
    }))
  })

  await page.route('**/api/beta/auth', async (route) => {
    expect(route.request().headers()['authorization']).toBe('Bearer tester-token')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ role: 'tester', tokenPreview: 'tester...oken', invite: { assignedName: 'Francisco' } }),
    })
  })

  await page.route('**/api/beta/rooms', async (route) => {
    expect(route.request().headers()['authorization']).toBe('Bearer tester-token')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        rooms: [{
          runId: 'run-shared',
          roomId: 'beta-run-shared',
          title: 'TEST',
          scenario: 'epidemic-gossip',
          dataType: 'product-catalog',
          nodeCount: 2,
          status: 'ready',
          createdAt: new Date().toISOString(),
        }],
      }),
    })
  })

  await page.route('**/api/beta/presence?roomId=beta-run-shared', async (route) => {
    expect(route.request().method()).toBe('GET')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        online: [
          { name: 'Davi', role: 'admin', mode: 'duo', participantId: 'coordinator-davi', roomId: 'beta-run-shared', lastSeen: new Date().toISOString() },
        ],
      }),
    })
  })

  await page.goto('/room')
  await page.getByRole('button', { name: 'Coordinator + tester' }).click()

  await expect(page.getByRole('button', { name: /TEST/ })).toBeVisible()
  await expect(page.locator('text', { hasText: 'Davi' })).toBeVisible()
  await expect(page.locator('.mesh-status strong')).toContainText(/waiting tester|ready/)
  await expect(page.getByRole('button', { name: 'Confirm profile to join' })).toBeVisible()
})

test('admin creates, revokes, and monitors tokens through routed pages', async ({ page }) => {
  let revoked = false
  let authCalls = 0
  let coordinatorJoined = false

  await page.route('**/api/beta/auth', async (route) => {
    authCalls += 1
    if (authCalls > 2) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ role: 'admin', tokenPreview: 'admin...oken', invite: null }),
    })
  })

  await page.route('**/api/beta/tokens', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          token: 'nodex-tester-created',
          tokenId: 'token-created',
          tokenPreview: 'nodex-test...ated',
          role: 'tester',
          label: 'Playwright tester',
          active: true,
          createdAt: new Date().toISOString(),
        }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        environment: [],
        createdTokens: [{
          tokenId: 'token-created',
          tokenPreview: 'nodex-test...ated',
          role: 'tester',
          label: 'Playwright tester',
          active: !revoked,
          revokedAt: revoked ? new Date().toISOString() : null,
          createdAt: new Date().toISOString(),
        }],
      }),
    })
  })

  await page.route('**/api/beta/tokens/token-created/revoke', async (route) => {
    revoked = true
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ token: { tokenId: 'token-created', active: false } }),
    })
  })

  await page.route('**/api/beta/runs', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          runId: 'run-playwright',
          roomId: 'beta-run-playwright',
          scenario: 'epidemic-gossip',
          dataType: 'product-catalog',
          nodeCount: 10,
          simulation: {
            simulationId: 'sim-playwright',
            runId: 'run-playwright',
            roomId: 'beta-run-playwright',
            scenario: 'epidemic-gossip',
            dataType: 'product-catalog',
            nodeCount: 10,
            requestCount: 40,
            metrics: {
              totalRequests: 40,
              swCache: 30,
              peerFetch: 7,
              serverFallback: 3,
              hitRatePct: 92.5,
              p50LatencyMs: 4,
              p95LatencyMs: 80,
              invalidationReachPct: 100,
              estimatedOriginReadsAvoided: 37,
            },
            events: [],
          },
        }),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [] }) })
  })

  await page.route('**/api/beta/logs', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ logs: [] }) })
  })
  await page.route('**/api/beta/audit', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ events: [] }) })
  })
  await page.route('**/api/beta/simulations', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ simulations: [] }) })
  })
  await page.route('**/api/beta/presence**', async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'POST') {
      coordinatorJoined = true
      const body = route.request().postDataJSON() as { name: string; roomId: string; mode: string }
      expect(body.name).toBe('Davi')
      expect(body.roomId).toBe('beta-run-playwright')
      expect(body.mode).toBe('group')
    }
    expect(url.searchParams.get('roomId') ?? 'beta-run-playwright').toBe('beta-run-playwright')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        online: coordinatorJoined
          ? [
              { name: 'Davi', role: 'admin', mode: 'group', participantId: 'coordinator-davi', roomId: 'beta-run-playwright', lastSeen: new Date().toISOString() },
              { name: 'Playwright Tester', role: 'tester', mode: 'group', participantId: 'beta-playwright', roomId: 'beta-run-playwright', lastSeen: new Date().toISOString() },
            ]
          : [],
      }),
    })
  })

  await page.goto('/')
  await page.getByLabel('Invitation token').fill('admin-token')
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page).toHaveURL(/\/admin$/)
  await page.getByRole('link', { name: 'Tokens' }).click()
  await expect(page.getByText('Opening Nodex beta suite...')).toHaveCount(0)
  await page.getByLabel('Label').fill('Playwright tester')
  await page.getByLabel('Tester name').fill('Created Tester')
  await page.getByLabel('Tester email').fill('created@example.test')
  await page.getByLabel('Personal note').fill('This token is just for Created Tester.')
  await page.getByRole('button', { name: 'Create token' }).click()
  await expect(page.getByText('nodex-tester-created')).toBeVisible()
  await page.getByRole('button', { name: 'Revoke' }).click()
  await expect(page.locator('.pill.danger', { hasText: 'revoked' })).toBeVisible()

  await page.getByRole('link', { name: 'Runs' }).click()
  await page.getByLabel('Run title').fill('Playwright run')
  await page.getByLabel('Coordinator name').fill('Davi')
  await page.getByRole('button', { name: 'Start simulated test' }).click()
  await expect(page.getByText('Run ready: beta-run-playwright')).toBeVisible()
  await expect(page.locator('#sim-hit-rate')).toHaveText('92.5%')
  await page.getByRole('button', { name: 'Join as coordinator' }).click()
  await expect(page.getByText('Live room')).toBeVisible()
  await expect(page.getByText('Davi')).toBeVisible()
  await expect(page.getByText('Playwright Tester')).toBeVisible()
  await expect(page.getByText('2/10 visible')).toBeVisible()
})
