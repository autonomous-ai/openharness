/*
 * Test support for the shared tabs specs (sharedTabs.spec.ts, sharedTabs.integration.spec.ts): one fake backend that
 * answers the real routes' shapes (backend/src/routes/agentMessages.ts, lib/agentMessageShares.ts), and a roster
 * signer for forgeries. Not product code: nothing outside the specs imports it.
 */
import { createHash } from 'node:crypto'
import { b64e, sign, type Identity } from '../lib/e2ee/core.js'
import { encodeRoster, rosterBytes, type Roster, type SignedRoster } from './roster.js'
import type { SharedTabsDeps } from './sharedTabs.js'

export type Reply = { status: number; body: Record<string, unknown> }
export const ok = (data: unknown): Reply => ({ status: 200, body: { success: true, data } })
export const fail = (status: number, code: string, more: Record<string, unknown> = {}): Reply => ({ status, body: { success: false, error: { code, message: `backend says ${code}`, ...more } } })
export const shareIdOf = (owner: string, tabId: string) => createHash('sha256').update(JSON.stringify(['amsg-share', owner, tabId])).digest('hex').slice(0, 24)

export interface Share { ownerUserId: string; ownerMachineId: string; tabId: string; version: number; roster: unknown; stopped: boolean }
export interface Invite { id: string; shareId: string; email: string; expiresAt: string; state: 'pending' | 'accepted' | 'revoked' }

export class FakeBackend {
  emails = new Map<string, string>()
  shares = new Map<string, Share>()
  members = new Map<string, Map<string, string>>()
  invites = new Map<string, Invite>()
  puts: Array<{ tabId: string; version: number; roster: SignedRoster }> = []
  /** Each account's desk tab settings' leader (`<userId>:<tabId>`), as `PATCH /api/agent-messages/tabs/:tabId` wrote it. */
  leaders = new Map<string, { machineId: string; agentId: string } | null>()
  calls: string[] = []
  down = false
  /** While set, every call waits for it: a refresh caught half way. */
  hold: Promise<void> | null = null
  /** A roster served to one account in place of the one held (`<userId>:<sharedTabId>`): a backend that lies to it. */
  served = new Map<string, unknown>()
  /** Told after every change, as the routes publish `share-changed` for the relay to check its sockets again. */
  changed: (() => void) | null = null
  /** Told each account a roster put tells (`desk_changed`, as the route publishes it): the owner's and its members'. */
  deskChanged: ((userId: string) => void) | null = null
  private seq = 0
  as(userId: string): SharedTabsDeps['backend'] {
    return async (method, path, body) => {
      this.calls.push(`${method} ${path}`)
      if (this.hold) await this.hold
      if (this.down) return { status: 502, body: {} }
      const reply = this.route(userId, method, path, (body ?? {}) as Record<string, unknown>)
      if (method !== 'GET' && reply.status === 200) this.changed?.()
      return reply
    }
  }
  private route(user: string, method: string, path: string, body: Record<string, unknown>): Reply {
    const email = this.emails.get(user)!
    let m: RegExpExecArray | null
    if (method === 'PUT' && (m = /^\/api\/agent-messages\/shares\/([^/]+)\/roster$/.exec(path))) {
      const tabId = decodeURIComponent(m[1]), id = shareIdOf(user, tabId), held = this.shares.get(id)
      // As the backend does: a stopped share starts again from any of the owner's machines, and its version only grows,
      // stopped or not; a put that is not newer is told the version held.
      if (held && !held.stopped && held.ownerMachineId !== body.machineId) return fail(403, 'FORBIDDEN')
      if (held && held.version >= (body.version as number)) return fail(409, 'STALE_ROSTER', { version: held.version })
      this.shares.set(id, { ownerUserId: user, ownerMachineId: String(body.machineId), tabId, version: body.version as number, roster: body.roster, stopped: false })
      this.puts.push({ tabId, version: body.version as number, roster: body.roster as SignedRoster })
      for (const told of [user, ...this.members.get(id)?.keys() ?? []]) this.deskChanged?.(told)
      return ok({ sharedTabId: id, version: body.version })
    }
    if (method === 'PATCH' && (m = /^\/api\/agent-messages\/tabs\/([^/]+)$/.exec(path))) {
      // As the route does: the account's word for its desk tab, which every computer of the account hears of
      // (`desk_changed`). The fake knows no desk, so it takes any leader; the listing derives it (sharedTabs.spec.ts).
      const tabId = decodeURIComponent(m[1]), leader = (body.leader ?? null) as { machineId: string; agentId: string } | null
      this.leaders.set(`${user}:${tabId}`, leader)
      this.deskChanged?.(user)
      return ok({ tabId, enabled: false, leader, revision: ++this.seq })
    }
    if (method === 'GET' && path === '/api/agent-messages/shares') {
      const shares = [...this.shares].filter(([id, s]) => !s.stopped && (s.ownerUserId === user || this.members.get(id)?.has(user))).map(([id, s]) => {
        const view = { sharedTabId: id, owner: s.ownerUserId === user, ownerEmail: this.emails.get(s.ownerUserId), ownerMachineId: s.ownerMachineId, version: s.version, roster: this.served.get(`${user}:${id}`) ?? s.roster }
        if (!view.owner) return view
        return { ...view, tabId: s.tabId,
          members: [...this.members.get(id) ?? []].map(([userId, acceptedAt]) => ({ userId, email: this.emails.get(userId), acceptedAt })),
          invites: [...this.invites.values()].filter((i) => i.shareId === id && i.state === 'pending').map((i) => ({ id: i.id, email: i.email, expiresAt: i.expiresAt })) }
      })
      return ok({ shares })
    }
    if (method === 'POST' && (m = /^\/api\/agent-messages\/shares\/([a-f0-9]{24})\/invites$/.exec(path))) {
      const share = this.shares.get(m[1])
      if (body.email === email) return fail(400, 'SELF_INVITE')
      if (!share || share.ownerUserId !== user || share.stopped) return fail(403, 'FORBIDDEN')
      const pending = [...this.invites.values()].filter((i) => i.shareId === m![1] && i.state === 'pending').length
      if ((this.members.get(m[1])?.size ?? 0) + pending >= 8) return fail(409, 'TAB_FULL')
      const id = `inv-${++this.seq}`
      this.invites.set(id, { id, shareId: m[1], email: String(body.email), expiresAt: new Date(Date.UTC(2026, 10, 1)).toISOString(), state: 'pending' })
      return ok({ id })
    }
    if (method === 'DELETE' && (m = /^\/api\/agent-messages\/invites\/([^/]+)$/.exec(path))) {
      const invite = this.invites.get(m[1])
      if (!invite || this.shares.get(invite.shareId)?.ownerUserId !== user) return fail(404, 'NOT_FOUND')
      invite.state = 'revoked'
      return ok({ revoked: true })
    }
    if (method === 'GET' && path === '/api/agent-messages/invites') {
      return ok({ invites: [...this.invites.values()].filter((i) => i.email === email && i.state === 'pending').map((i) => ({
        id: i.id, sharedTabId: i.shareId, ownerEmail: this.emails.get(this.shares.get(i.shareId)!.ownerUserId), ownerMachineId: this.shares.get(i.shareId)!.ownerMachineId, expiresAt: i.expiresAt,
        // As the backend does: the name in the roster body it holds.
        tabName: String((JSON.parse((this.shares.get(i.shareId)!.roster as { body: string }).body) as { name?: unknown }).name ?? '') })) })
    }
    if (method === 'POST' && (m = /^\/api\/agent-messages\/invites\/([^/]+)\/accept$/.exec(path))) {
      const invite = this.invites.get(m[1])
      if (!invite || invite.email !== email || invite.state !== 'pending') return fail(404, 'NOT_FOUND')
      invite.state = 'accepted'
      if (!this.members.has(invite.shareId)) this.members.set(invite.shareId, new Map())
      this.members.get(invite.shareId)!.set(user, new Date(Date.UTC(2026, 9, 15)).toISOString())
      return ok({ sharedTabId: invite.shareId })
    }
    if (method === 'DELETE' && (m = /^\/api\/agent-messages\/shares\/([a-f0-9]{24})\/members\/([^/]+)$/.exec(path))) {
      const share = this.shares.get(m[1])
      if (!share || (share.ownerUserId !== user && m[2] !== user) || !this.members.get(m[1])?.delete(m[2])) return fail(403, 'FORBIDDEN')
      return ok({ removed: true })
    }
    if (method === 'POST' && (m = /^\/api\/agent-messages\/shares\/([a-f0-9]{24})\/move$/.exec(path))) {
      // As moveShare: only the owner's live share; the machine is taken as the owner's (the fake knows no machines).
      const share = this.shares.get(m[1])
      if (!share || share.ownerUserId !== user || share.stopped) return fail(404, 'NOT_FOUND')
      share.ownerMachineId = String(body.machineId)
      return ok({ sharedTabId: m[1] })
    }
    if (method === 'DELETE' && (m = /^\/api\/agent-messages\/shares\/([a-f0-9]{24})$/.exec(path))) {
      const share = this.shares.get(m[1])
      if (!share || share.ownerUserId !== user) return fail(403, 'FORBIDDEN')
      share.stopped = true
      this.members.delete(m[1])
      for (const i of this.invites.values()) if (i.shareId === m[1] && i.state === 'pending') i.state = 'revoked'
      return ok({ stopped: true })
    }
    return fail(404, 'NO_ROUTE')
  }
}

export type Pane = { machineId: string; agentId: string; name: string; engine: string }

/** A roster signed by whichever key is given: the owner's for a test's own roster, another's for a forgery. */
export const resign = (by: Identity, r: Roster, keyChange?: SignedRoster['keyChange']): SignedRoster => {
  const body = encodeRoster(r)
  return { body, signature: b64e(sign(by.priv, rosterBytes(r.sharedTabId, r.version, body))), ...(keyChange ? { keyChange } : {}) }
}
