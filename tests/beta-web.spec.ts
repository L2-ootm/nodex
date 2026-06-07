import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test('beta page creates a token-auth session and submits collected evidence', async ({ page }) => {
  await page.route('**/api/beta/auth', async (route) => {
    const request = route.request()
    expect(request.headers()['authorization']).toBe('Bearer playwright-token')
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

  await page.route('http://localhost:3003/api/beta/sessions', async (route) => {
    const request = route.request()
    expect(request.headers()['authorization']).toBe('Bearer playwright-token')
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        participantId: 'beta-playwright',
        sessionToken: 'beta-session-playwright',
        roomId: 'beta-room-playwright',
        testUrl: 'http://localhost:4173/?nodexRoom=beta-room-playwright&nodexTopology=beta-external&nodexSignalingUrl=ws://localhost:3002/ws',
      }),
    })
  })

  await page.route('http://localhost:3003/api/beta/evidence', async (route) => {
    const request = route.request()
    expect(request.headers()['authorization']).toBe('Bearer beta-session-playwright')
    const body = request.postDataJSON() as {
      participantId: string
      roomId: string
      topologyLabel: string
      result: string
    }
    expect(body.participantId).toBe('beta-playwright')
    expect(body.roomId).toBe('beta-room-playwright')
    expect(body.topologyLabel).toBe('lan-multi-machine')
    expect(body.result).toBe('pass')
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ evidenceId: 'evidence-playwright' }),
    })
  })
  await page.route('http://localhost:3003/api/beta/logs', async (route) => {
    const request = route.request()
    expect(request.headers()['authorization']).toBe('Bearer playwright-token')
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ logId: 'log-playwright' }),
    })
  })

  await page.goto('/')

  await page.getByLabel('Invitation token').fill('playwright-token')
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByText('This invite is reserved for your browser flow test.')).toBeVisible()
  await page.getByRole('button', { name: /Just me/ }).click()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Playwright Tester')
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('playwright@example.test')
  await page.getByLabel('City', { exact: true }).fill('Sao Paulo')
  await page.getByLabel('Country', { exact: true }).fill('BR')
  await page.getByLabel('Network', { exact: true }).fill('local test')
  await page.getByLabel('Contribution Note', { exact: true }).fill('Browser form validation run.')
  await page.getByLabel(/consent/i).check()
  await page.getByRole('button', { name: 'Create Session' }).click()

  await expect(page.getByText('beta-playwright')).toBeVisible()
  await expect(page.locator('#room-id')).toHaveText('beta-room-playwright')

  await page.getByRole('link', { name: 'Evidence' }).click()
  await page.getByLabel('Topology').selectOption('lan-multi-machine')
  await page.getByLabel('Notes').fill('Connected on same LAN.')
  await page.getByRole('button', { name: 'Save Evidence' }).click()
  await expect(page.getByText('Evidence saved. Sending your logs now...')).toBeVisible()
  await expect(page.getByText('All done. Your logs have been sent to the admin panel.')).toBeVisible()
})

test('admin token opens lab controls for token creation and simulated runs', async ({ page }) => {
  await page.route('http://localhost:3003/api/beta/auth', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ role: 'admin', tokenPreview: 'admin...oken' }),
    })
  })
  await page.route(/.*\/api\/beta\/tokens$/, async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          token: 'nodex-tester-created',
          tokenId: 'token-created',
          role: 'tester',
          tokenPreview: 'nodex-test...ated',
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
      body: JSON.stringify({ environment: [], createdTokens: [] }),
    })
  })
  await page.route(/.*\/api\/beta\/runs$/, async (route) => {
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
          testUrl: 'http://localhost:4173/?nodexRoom=beta-run-playwright',
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
            events: [
              { key: '/api/beta-sim/product-catalog/1', nodeId: 'node-1', source: 'sw-cache', latencyMs: 3 },
            ],
          },
        }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: [] }),
    })
  })
  await page.route(/.*\/api\/beta\/simulations$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ simulations: [] }),
    })
  })
  await page.route(/.*\/api\/beta\/logs$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ logs: [] }),
    })
  })
  await page.route(/.*\/api\/beta\/audit$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ events: [] }),
    })
  })

  await page.goto('/')
  await page.getByLabel('Invitation token').fill('admin-token')
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.locator('#admin').getByText('Admin lab')).toBeVisible()
  await page.getByLabel('Label').fill('Playwright tester')
  await page.getByLabel('Tester name').fill('Created Tester')
  await page.getByLabel('Tester email').fill('created@example.test')
  await page.getByLabel('Personal note').fill('This token is just for Created Tester.')
  await page.getByRole('button', { name: 'Create Token' }).click()
  await expect(page.getByText('nodex-tester-created')).toBeVisible()

  await page.getByLabel('Run title').fill('Playwright run')
  await page.getByRole('button', { name: 'Start Simulated Test' }).click()
  await expect(page.getByText('Run ready: beta-run-playwright')).toBeVisible()
  await expect(page.locator('#sim-hit-rate')).toHaveText('92.5%')
  await expect(page.getByText('node-1 sw-cache 3ms')).toBeVisible()
})
