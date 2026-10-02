import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { getPublisher } from '../src/server/publisher.js'
import { cors } from 'hono/cors'

export const config = { runtime: 'nodejs' }
export const app = new Hono()
app.use('*', cors({ origin: '*' }))
app.get('/api/publisher-key', async c => {
  c.header('Cache-Control', 'no-store')
  try { return c.json((await getPublisher()).identity) }
  catch { return c.json({ error: 'publisher unavailable' }, 503) }
})
const handler = handle(app)
export const GET = handler
export const OPTIONS = handler
