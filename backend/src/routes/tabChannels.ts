import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { readTabChannels, readTabChannelSettings, setTabChannelSettings } from '../lib/tabChannels.js'
import { publishDeskChanged } from '../lib/bus.js'
import { validateBody } from '../middlewares/validation.js'
import { sendSuccess } from '../utils/response.js'

/** Separate from /api/desk: old clients and rolling backend upgrades keep the
 * exact same tab document. This endpoint exposes routing, never conversations. */
export async function tabChannelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tab-channels/settings', async (req, reply) => {
    sendSuccess(reply, await readTabChannelSettings(req.user!.sub))
  })
  app.patch<{ Body: { enabled: boolean } }>('/api/tab-channels/settings', {
    preHandler: validateBody(z.object({ enabled: z.boolean() }).strict()),
  }, async (req, reply) => {
    const userId = req.user!.sub
    const settings = await setTabChannelSettings(userId, req.body.enabled)
    // Reuse the existing account invalidation transport without changing desk data.
    void publishDeskChanged(userId, { revision: 0 })
    sendSuccess(reply, settings)
  })
  app.get('/api/tab-channels', async (req, reply) => {
    sendSuccess(reply, await readTabChannels(req.user!.sub))
  })
}
