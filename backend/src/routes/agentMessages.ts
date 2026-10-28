import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { readAgentMessages, setAgentMessages } from '../lib/agentMessages.js'
import { accept, accountIdByEmail, invite, listShares, moveShare, pendingInvites, putRoster, removeMember, revokeInvite, shareMemberIds,
  shareOwner, stopSharing } from '../lib/agentMessageShares.js'
import { publishAgentMessageShareChanged, publishDeskChanged } from '../lib/bus.js'
import { validateBody } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'

const tabId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)
const sharedId = z.string().regex(/^[a-f0-9]{24}$/)
const DAY = 86_400_000

const STATUS: Record<string, number> = { FORBIDDEN: 403, STALE_ROSTER: 409, ROSTER_TOO_LARGE: 413, SELF_INVITE: 400,
  TAB_FULL: 409, ALREADY_MEMBER: 409, NOT_FOUND: 404, EXPIRED: 410 }
const MESSAGE: Record<string, string> = {
  FORBIDDEN: 'Only the tab\'s owner, from the computer that shares it, can do that.',
  STALE_ROSTER: 'A newer roster is already shared.', ROSTER_TOO_LARGE: 'The roster is too large.',
  SELF_INVITE: 'You are already in this tab.', TAB_FULL: 'This tab has 8 people already.', ALREADY_MEMBER: 'They are already in this tab.',
  NOT_FOUND: 'This invitation is no longer available.', EXPIRED: 'This invitation expired.',
}
/** A move's refusals mean something else than the same codes elsewhere: they are told in words of their own. */
const MOVE_MESSAGE: Record<string, string> = {
  FORBIDDEN: 'Only the tab\'s owner can move it, to a computer of theirs that is signed in.', NOT_FOUND: 'This tab is no longer shared.',
}
const fail = (reply: FastifyReply, code: string, details?: Record<string, unknown>, message = MESSAGE[code]) => sendError(reply, message, code, STATUS[code], details)
const invalidShare = (reply: FastifyReply) => sendError(reply, 'Choose a shared tab.', 'INVALID_TAB', 400)

/**
 * Every account that sees a share (or the list of them) re-reads on `desk_changed`; the relay re-checks who may stay.
 * Best effort, once the change is saved: a lookup of who else to tell (`more`) or a publish that fails is logged, and
 * never turns the saved change into an error the caller would retry.
 */
async function tell(log: FastifyBaseLogger, shareId: string, known: (string | null)[], more: () => Promise<(string | null)[]> = async () => []): Promise<void> {
  const warn = (error: unknown) => log.warn({ err: error, shareId }, 'agent messages: could not tell who must re-read a shared tab')
  const extra = await more().catch((error: unknown) => { warn(error); return [] })
  for (const id of new Set([...known, ...extra])) if (id) publishDeskChanged(id, { revision: 0 }).catch(warn)
  publishAgentMessageShareChanged(shareId).catch(warn)
}

const rosterBody = z.object({
  machineId: z.string().min(1).max(200),
  version: z.number().int().positive().safe(),
  roster: z.record(z.string(), z.unknown()),
}).strict()
const moveBody = z.object({ machineId: z.string().min(1).max(200) }).strict()
const tabBody = z.object({
  enabled: z.boolean().optional(),
  leader: z.object({ machineId: z.string().min(1).max(200), agentId: z.string().min(1).max(160) }).strict().nullable().optional(),
}).strict().refine(b => b.enabled !== undefined || b.leader !== undefined)
const inviteBody = z.object({
  email: z.string().email().max(320),
  days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
}).strict()

/** Agent Messages, per tab (lib/agentMessages.ts). Separate from /api/desk, whose tab document never changes
 *  for it. */
export async function agentMessagesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agent-messages', async (req, reply) => {
    sendSuccess(reply, await readAgentMessages(req.user!.sub))
  })
  app.patch<{ Params: { tabId: string }; Body: z.infer<typeof tabBody> }>('/api/agent-messages/tabs/:tabId', {
    preHandler: validateBody(tabBody),
  }, async (req, reply) => {
    const parsed = tabId.safeParse(req.params.tabId)
    if (!parsed.success) return sendError(reply, 'Choose a tab on your desk.', 'INVALID_TAB', 400)
    const userId = req.user!.sub
    const result = await setAgentMessages(userId, parsed.data, req.body)
    if ('error' in result) return sendError(reply, 'Choose a harness in this tab.', 'INVALID_LEADER', 400)
    // Every daemon of the account re-reads its directory on `desk_changed`, and every window its tabs: the
    // account's existing invalidation, with the desk itself unchanged.
    void publishDeskChanged(userId, { revision: 0 })
    sendSuccess(reply, result)
  })

  // Shared tabs across accounts (lib/agentMessageShares.ts): the routes validate, call, and tell who must re-read.
  app.put<{ Params: { tabId: string }; Body: z.infer<typeof rosterBody> }>('/api/agent-messages/shares/:tabId/roster', {
    preHandler: validateBody(rosterBody),
  }, async (req, reply) => {
    const parsed = tabId.safeParse(req.params.tabId)
    if (!parsed.success) return sendError(reply, 'Choose a tab on your desk.', 'INVALID_TAB', 400)
    const user = req.user!
    const { machineId, version, roster } = req.body
    const result = await putRoster({ ownerUserId: user.sub, tabId: parsed.data, machineId, version, roster, autonomousEnv: user.autonomousEnv })
    // A stale roster is told the version held, which the owner's computer signs its next one past.
    if ('error' in result) return fail(reply, result.error, result.error === 'STALE_ROSTER' ? { version: result.version } : undefined)
    // The members too: a roster that lists none of their machines yet reaches them only by reading it again.
    await tell(req.log, result.sharedTabId, [user.sub], () => shareMemberIds(result.sharedTabId))
    sendSuccess(reply, result)
  })
  app.get('/api/agent-messages/shares', async (req, reply) => {
    sendSuccess(reply, { shares: await listShares(req.user!.sub, req.user!.autonomousEnv) })
  })
  app.post<{ Params: { sharedTabId: string }; Body: z.infer<typeof inviteBody> }>('/api/agent-messages/shares/:sharedTabId/invites', {
    preHandler: validateBody(inviteBody),
  }, async (req, reply) => {
    const id = sharedId.safeParse(req.params.sharedTabId)
    if (!id.success) return invalidShare(reply)
    const user = req.user!
    const result = await invite({ ownerUserId: user.sub, ownerEmail: user.email, sharedTabId: id.data, email: req.body.email,
      expiresAt: new Date(Date.now() + req.body.days * DAY), autonomousEnv: user.autonomousEnv })
    if ('error' in result) return fail(reply, result.error)
    await tell(req.log, id.data, [user.sub], async () => [await accountIdByEmail(req.body.email)])
    sendSuccess(reply, { id: result.id })
  })
  app.delete<{ Params: { id: string } }>('/api/agent-messages/invites/:id', async (req, reply) => {
    const revoked = await revokeInvite(req.user!.sub, req.params.id)
    if (!revoked) return fail(reply, 'NOT_FOUND')
    await tell(req.log, revoked.shareId, [req.user!.sub], async () => [await accountIdByEmail(revoked.email)])
    sendSuccess(reply, { revoked: true })
  })
  app.get('/api/agent-messages/invites', async (req, reply) => {
    sendSuccess(reply, { invites: await pendingInvites(req.user!.email, req.user!.autonomousEnv) })
  })
  app.post<{ Params: { id: string } }>('/api/agent-messages/invites/:id/accept', async (req, reply) => {
    const result = await accept(req.user!, req.params.id)
    if ('error' in result) return fail(reply, result.error)
    await tell(req.log, result.sharedTabId, [req.user!.sub], async () => [await shareOwner(result.sharedTabId)])
    sendSuccess(reply, { sharedTabId: result.sharedTabId })
  })
  app.delete<{ Params: { sharedTabId: string; userId: string } }>('/api/agent-messages/shares/:sharedTabId/members/:userId', async (req, reply) => {
    const id = sharedId.safeParse(req.params.sharedTabId)
    if (!id.success) return invalidShare(reply)
    if (!await removeMember(req.user!.sub, id.data, req.params.userId)) return fail(reply, 'FORBIDDEN')
    await tell(req.log, id.data, [req.params.userId], async () => [await shareOwner(id.data)])
    sendSuccess(reply, { removed: true })
  })
  app.post<{ Params: { sharedTabId: string }; Body: z.infer<typeof moveBody> }>('/api/agent-messages/shares/:sharedTabId/move', {
    preHandler: validateBody(moveBody),
  }, async (req, reply) => {
    const id = sharedId.safeParse(req.params.sharedTabId)
    if (!id.success) return invalidShare(reply)
    const user = req.user!
    const result = await moveShare(user.sub, id.data, req.body.machineId, user.autonomousEnv)
    if ('error' in result) return fail(reply, result.error, undefined, MOVE_MESSAGE[result.error])
    // Every computer of the owner and of its members reads the share again: the new computer's roster follows.
    await tell(req.log, id.data, [user.sub], () => shareMemberIds(id.data))
    sendSuccess(reply, result)
  })
  app.delete<{ Params: { sharedTabId: string } }>('/api/agent-messages/shares/:sharedTabId', async (req, reply) => {
    const id = sharedId.safeParse(req.params.sharedTabId)
    if (!id.success) return invalidShare(reply)
    // Stopping removes the members, so who to tell is read first.
    const members = await shareMemberIds(id.data)
    if (!await stopSharing(req.user!.sub, id.data)) return fail(reply, 'FORBIDDEN')
    await tell(req.log, id.data, [req.user!.sub, ...members])
    sendSuccess(reply, { stopped: true })
  })
}
