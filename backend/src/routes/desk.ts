/**
 * The account's desk — its tabs, the same on every computer (lib/desk.ts for the rules).
 *
 *   GET  /api/desk       → { revision, tabs }
 *   POST /api/desk/ops   → { ops } applied in order under `revision`, answers the new { revision, tabs }
 *
 * A write that lost a race with another window (the revision moved under it) is retried from the
 * fresh document: the ops are idempotent and drop-on-missing, so replaying them is the merge. After
 * a change every adapter socket of the user hears `desk_changed` (lib/adapterWs.ts) and re-fetches.
 */
import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import type { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { publishDeskChanged } from '../lib/bus.js'
import { applyDeskOps, deskOpsBodySchema, parseTabs, type DeskDoc } from '../lib/desk.js'
import { validateBody } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'

const WRITE_ATTEMPTS = 5

async function readDesk(userId: string): Promise<DeskDoc> {
  const row = await prisma.desk.findUnique({ where: { userId } })
  return row ? { revision: row.revision, tabs: parseTabs(row.tabs) } : { revision: 0, tabs: [] }
}

export async function deskRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/desk', async (req, reply) => {
    sendSuccess(reply, await readDesk(req.user!.sub))
  })

  app.post<{ Body: z.infer<typeof deskOpsBodySchema> }>(
    '/api/desk/ops', { preHandler: [validateBody(deskOpsBodySchema)] },
    async (req, reply) => {
      const userId = req.user!.sub
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
        const current = await readDesk(userId)
        const applied = applyDeskOps(current.tabs, req.body.ops)
        // Nothing moved — the same click twice, or ops on tabs already gone. Say where we are.
        if (!applied.changed) return sendSuccess(reply, current)
        const next = { revision: current.revision + 1, tabs: applied.tabs }
        const tabs = next.tabs as unknown as Prisma.InputJsonValue
        // Compare-and-set on the revision: whoever wrote first wins, the other re-reads and replays.
        const bumped = await prisma.desk.updateMany({ where: { userId, revision: current.revision }, data: { revision: next.revision, tabs } })
        if (bumped.count !== 1) {
          if (current.revision !== 0) continue
          // No row yet (the only way revision 0 and no update): make it. A second window making it at
          // the same moment trips the unique index and re-reads what the first one wrote.
          try {
            await prisma.desk.create({ data: { userId, revision: next.revision, tabs } })
          } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue
            throw error
          }
        }
        void publishDeskChanged(userId, { revision: next.revision })
        return sendSuccess(reply, next)
      }
      return sendError(reply, 'The desk is changing too quickly; try again.', 'DESK_BUSY', 409)
    },
  )
}
