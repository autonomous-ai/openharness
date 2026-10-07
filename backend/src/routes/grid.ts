import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { harnessGridName } from '../lib/gridName.js'
import { answerGridProfile, GRID_PROFILE_PATH } from '../lib/gridProfile.js'
import { bearerToken } from '../lib/ssoAuth.js'

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

  /**
   * `GET /api/grid/profile` — GRID-ONLY. Who holds this Harness sign-in token, asked by the Grid
   * control plane (grid-apis `POST /v1/grid/auth/harness`) with the person's token as the bearer.
   *
   * ⚠️ **Autonomous-shaped, not Harness-shaped, and that is the contract** (ADR 0046 in the
   * autonomous-grid repository; `lib/gridProfile.ts`): the success body is `{status: 1, data: {id,
   * email, full_name, customer_socials}}`, written directly — never through `sendSuccess`. Do not tidy
   * it. `fixtures/gridProfile.contract.json` pins it, and grid-apis parses a copy of that file.
   *
   * No parameter names an account — path, query and body are all ignored; the account is the token's.
   * The authentication middleware does not stamp the user's country for this path: the caller is a
   * server acting for the person, not their device.
   *
   *   Autonomous token  → a live profile read (Autonomous 401 → 401, unreachable or 5xx → 503)
   *   computer sign-in  → the stored values; never checked → 409 (and 409 means only that here)
   *   phone sign-in, staging-plane account, provisional customer id → 403
   *   more than GRID_PROFILE_LIVE_READS_PER_MINUTE live reads for one account → 429
   */
  app.get(GRID_PROFILE_PATH, async (req, reply) => {
    const answer = await answerGridProfile(req.user!, bearerToken(req.headers['authorization'])!)
    // A person's email, name and Google subject: nothing between here and the caller may keep it.
    reply.header('Cache-Control', 'no-store')
    if (answer.status === 200) return reply.code(200).send(answer.body)
    return sendError(reply, answer.message, answer.code, answer.status)
  })
}
