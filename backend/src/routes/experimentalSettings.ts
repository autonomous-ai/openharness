import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { experimentalFeatures, readExperimentalSettings, setExperimentalSetting } from '../lib/experimentalSettings.js'
import { daemonsFor, DAEMONS_DARK, type DaemonsSwitch } from '../lib/daemonsSwitch.js'
import { publishDeskChanged, publishZooChanged } from '../lib/bus.js'
import { validateBody } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'

const settingBody = z.object({ accountId: z.string().min(1).max(200), feature: z.enum(experimentalFeatures), enabled: z.boolean() }).strict()

export async function experimentalSettingsRoutes(app: FastifyInstance, opts: { daemons?: DaemonsSwitch } = {}) {
  const available = (user: { sub: string; email?: string | null } | undefined) => ({
    focus_bar_creature: daemonsFor(opts.daemons ?? DAEMONS_DARK, user), share_button: true, devices_tab: true,
  })
  app.get('/api/experimental-settings', async (req, reply) => {
    sendSuccess(reply, { accountId: req.user!.sub, ...await readExperimentalSettings(req.user!.sub), available: available(req.user) })
  })
  app.patch<{ Body: z.infer<typeof settingBody> }>('/api/experimental-settings', {
    preHandler: validateBody(settingBody),
  }, async (req, reply) => {
    const { feature, enabled } = req.body
    if (req.body.accountId !== req.user!.sub) return sendError(reply, 'Your account changed. Reopen Settings and try again.', 'ACCOUNT_CHANGED', 409)
    const availability = available(req.user)
    if (enabled && !availability[feature]) return sendError(reply, 'This experiment is unavailable on this server.', 'EXPERIMENT_UNAVAILABLE', 503)
    const userId = req.user!.sub
    const settings = await setExperimentalSetting(userId, feature, enabled)
    // Existing account invalidations reach old and new daemons without changing the desk document.
    void publishDeskChanged(userId, { revision: 0 })
    if (feature === 'focus_bar_creature') void publishZooChanged(userId, { revision: 0 })
    sendSuccess(reply, { accountId: userId, ...settings, available: availability })
  })
}
