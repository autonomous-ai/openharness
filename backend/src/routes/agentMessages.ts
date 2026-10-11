import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { readAgentMessages, setAgentMessages } from '../lib/agentMessages.js'
import { publishDeskChanged } from '../lib/bus.js'
import { validateBody } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'

const tabId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)

/** Agent Messages, per tab (lib/agentMessages.ts). Separate from /api/desk, whose tab document never changes
 *  for it. */
export async function agentMessagesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agent-messages', async (req, reply) => {
    sendSuccess(reply, await readAgentMessages(req.user!.sub))
  })
  app.patch<{ Params: { tabId: string }; Body: { enabled: boolean } }>('/api/agent-messages/tabs/:tabId', {
    preHandler: validateBody(z.object({ enabled: z.boolean() }).strict()),
  }, async (req, reply) => {
    const parsed = tabId.safeParse(req.params.tabId)
    if (!parsed.success) return sendError(reply, 'Choose a tab on your desk.', 'INVALID_TAB', 400)
    const userId = req.user!.sub
    const result = await setAgentMessages(userId, parsed.data, req.body.enabled)
    // Every daemon of the account re-reads its directory on `desk_changed`, and every window its tabs: the
    // account's existing invalidation, with the desk itself unchanged.
    void publishDeskChanged(userId, { revision: 0 })
    sendSuccess(reply, result)
  })
}
