import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { sendSuccess } from '../utils/response.js'
import { harnessGridName } from '../lib/gridName.js'

/**
 * `POST /api/grid/name` — read the account's grid name, minting it on the first ask.
 *
 * No body: the user comes from the SSO token the control API already gates on, never from the path,
 * so there is nothing here for one account to point at another's.
 *
 * Idempotent by construction, which is why there is no `GET` twin — a client that loses the response
 * asks again and gets the same string.
 */
export async function gridRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/grid/name', async (req, reply) => {
    const userId = req.user!.sub
    const minted = harnessGridName(req.user!.email, userId)

    // Compare-and-set, not a transaction: only a row that has NOT claimed a name matches, so two
    // machines signing in at once converge on one name instead of creating two grids.
    //
    // ⚠️ `gridName: null` alone is NOT enough on MongoDB — every user row written before this field
    // existed LACKS it entirely, and absent does not match null. This is the same trap `Machine.
    // deletedAt` documents in schema.prisma; `isSet: false` is what covers the legacy rows, and
    // without it the claim would never match anyone who signed up before today.
    const { count } = await prisma.user.updateMany({
      where: { id: userId, OR: [{ gridName: null }, { gridName: { isSet: false } }] },
      data: { gridName: minted },
    })
    if (count === 1) return sendSuccess(reply, { gridName: minted })

    // Someone else claimed it first (another machine of this user, moments ago) — or this account
    // has had a name for a while. Either way the stored value wins; the loser adopts rather than
    // creating a second grid. Falling back to `minted` covers only the impossible read-after-write
    // miss, and returns the same string the winner would have stored anyway.
    const existing = await prisma.user.findUnique({ where: { id: userId }, select: { gridName: true } })
    return sendSuccess(reply, { gridName: existing?.gridName ?? minted })
  })
}
