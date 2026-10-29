/**
 * The host form (design 4.10): for one machine, the rows of every Swarm it serves (full), or of the Swarms with a change
 * that concerns it since the cursor (incremental). Grants and billing live outside the parts, so the host asks for a full
 * read at start and at least every 60 s.
 */
import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../lib/ssoAuth.js'
import { machineAlive } from '../../lib/prisma.js'
import { isTeamSession } from '../../lib/teamSession.js'
import { machineBillingAllowsDataPlane } from '../../lib/billingState.js'
import { fail, type SuperTabState } from '../model.js'
import { GrantReads, TEAM_HOST_ONLY, TEAM_HOST_ONLY_MESSAGE, teamByRecord, type SuperTabStore } from '../store.js'
import type { CacheView } from '../cache.js'
import { readLastChangedAts, readMachines } from '../cachedReads.js'
import { retryTransient } from '../retry.js'
import * as parts from '../parts/index.js'
import type { MachineData, Part } from '../parts/index.js'
import { groupsBy, retryStaleIndex } from '../parts/indexed.js'
import { plainHost } from '../parts/commit.js'
import { READ_FORMAT, type HostChanges, type HostChangesRequest } from './contract.js'
import { cursorFor, readCursor } from './cursor.js'
import { hostTab, type HostLookups } from './hostRows.js'
import { confidentialSessions } from '../confidential.js'
import { machineSwarms, swarmsIn } from '../swarmRows.js'

type Transaction = Prisma.TransactionClient
/** The row hash's length at the front of an etag (read/hostEtag.ts); the input signature follows it. */
const ROW_HASH = 22
/** A full read covers this many of the machine's Swarms, most recently changed first (was 100 full Swarms each second). */
const FULL_TABS = 500

/** A change this machine's host cares about from the part alone (parts/commit.ts plainHost, the rule the push shares). */
function plainlyRelevant(part: Part, machineId: string): boolean {
  const host = plainHost(part.kind, part.data)
  return host === 'all' || host === machineId
}
const PLAIN_KINDS = ['head', 'member', 'agent', 'start'] as const

export class HostReads {
  private readonly db: PrismaClient
  private readonly now: () => number
  /** Reads the store's own database, on its clock unless given one (tests). */
  constructor(private readonly store: SuperTabStore, private readonly options: { now?: () => number; githubApp?: boolean; teamAccountsIdle?: boolean } = {}) {
    this.db = store.db
    this.now = options.now ?? store.now
  }

  async changes(user: AuthUser, machineId: string, request: HostChangesRequest): Promise<HostChanges> {
    const t0 = this.now()
    const from = request.cursor && !request.full ? readCursor(request.cursor, 0, t0) : { reload: true as const }
    // Outside any transaction: each Swarm's signature and state come through the read cache (cache.ts), at stamps read once.
    const tx = this.db
    const owned = await tx.machine.findFirst({ where: { machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
    await this.store.hostFor(tx, user, machineId, owned)
    if (!owned || !machineBillingAllowsDataPlane(owned)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
    // Every agent's grant check of this read shares one read of each machine, share, contributor and Workspace membership.
    const grants = new GrantReads(owned)
    // Swarms still in one row are migrated when first opened; the job migrates every one before the new release serves.
    const ids = await machineSwarms(tx, user.autonomousEnv, machineId, FULL_TABS)
    const teams = isTeamSession(user) || this.options.teamAccountsIdle ? [] : await tx.machine.findMany({ where: { userId: user.sub,
      hostMachineId: machineId, sessionKind: 'team', autonomousEnv: user.autonomousEnv, ...machineAlive }, select: { machineId: true } })
    const full = 'reload' in from
    const woken = full ? null : await this.woken(tx, ids, machineId, from.since)
    const tabs = []
    const answered = woken ? ids.filter(id => woken.has(id)) : ids
    const cached = await this.store.view(answered)
    const newest = await readLastChangedAts(tx, cached, answered)
    for (const tabId of ids) {
      if (woken && !woken.has(tabId)) continue
      // A wake can repeat while the cursor overlaps the same change. Share the timestamp at the read's stamp instead
      // of scanning every part kind again before the unchanged-etag shortcut.
      const lastChangedAt = newest.get(tabId) ?? null, held = request.held?.[tabId]
      // The etag is the rows' hash and then the signature of what they were built from. A matching signature answers
      // 'unchanged' from version columns alone. Never on a full read: grants and billing live outside the parts.
      const inputs = await cached.get(tabId, 'host:inputs', 'main', () => this.inputs(tx, tabId))
      if (!full && held && inputs && held.slice(ROW_HASH) === inputs) { tabs.push({ tabId, lastChangedAt, etag: held, unchanged: true as const }); continue }
      const state = await this.tabState(tx, cached, tabId, machineId)
      // Its Team account alone hosts a machine this Swarm records as one, whatever its account row says now (store.ts).
      if (!isTeamSession(user) && teamByRecord(state, machineId)) fail(TEAM_HOST_ONLY, TEAM_HOST_ONLY_MESSAGE, 403)
      const rows = await hostTab(tabId, state, machineId, user, lastChangedAt, await this.lookups(tx, state, teams, grants))
      const etag = rows.etag + (inputs ?? '')
      // The host already holds these rows: say so instead of sending them again.
      tabs.push(held?.slice(0, ROW_HASH) === rows.etag ? { tabId, lastChangedAt, etag, unchanged: true as const } : { ...rows, etag })
    }
    return { format: READ_FORMAT, full, cursor: cursorFor(t0, 0), tabs,
      removedTabIds: full ? [] : await this.removed(tx, user.autonomousEnv, machineId, from.since, new Set(ids)) }
  }

  /**
   * The Swarms with a change for this machine's host since the cursor. Groups and machine parts go by the markers their
   * writes left (parts/commit.ts), since their new data alone cannot say it: a group concerns the host when its agents or
   * its work were on this machine before or after the write (an agent leaving its last group, review round 1); a machine
   * part when its settings or ledger changed, never when only its reading did (every 15 s; group 5's run, 2026-10-26).
   */
  private async woken(tx: Transaction, ids: string[], machineId: string, since: number): Promise<Set<string>> {
    // A host with no Swarm polls every second: an empty list would reach Prisma as `$or: []`, a scan of the whole collection.
    if (!ids.length) return new Set()
    const after = new Date(since)
    const [changed, groups, machines] = await Promise.all([
      parts.loadChanged(tx, ids, after, PLAIN_KINDS),
      // Through the host's own index by name (parts/indexed.ts): every host runs this every second, and reads no other host's.
      groupsBy(tx, 'wake', [{ $match: { tabId: { $in: ids }, changedAt: { $gt: { $date: after.toISOString() } }, hostMachineIds: machineId } },
        { $project: { _id: 0, tabId: 1 } }]) as Promise<unknown> as Promise<Array<{ tabId: string }>>,
      tx.swarmMachine.findMany({ where: { tabId: { in: ids }, hostChangedAt: { gt: after } }, select: { tabId: true, key: true, data: true } }),
    ])
    const woken = new Set([...ids.filter(id => changed.get(id)?.some(p => plainlyRelevant(p, machineId))), ...groups.map(g => g.tabId)])
    // This machine's own settings, a team account's pool on this Mac, or the Mac this team account follows. Not read when no
    // machine changed, as on most polls: Prisma sends an empty list as a filter no index serves, a scan of every Swarm's machines.
    const follows = new Map(machines.length ? (await tx.swarmMachine.findMany({ where: { tabId: { in: [...new Set(machines.map(m => m.tabId))] }, key: machineId },
      select: { tabId: true, data: true } })).map(m => [m.tabId, (m.data as MachineData | null)?.contribution?.hostMachineId]) : [])
    for (const m of machines) {
      if (m.key === machineId || (m.data as MachineData | null)?.contribution?.hostMachineId === machineId || follows.get(m.tabId) === m.key) woken.add(m.tabId)
    }
    return woken
  }

  /** The Swarm's active parts plus, dormant ones included, every group its agents on this machine are in (a finished
   *  group that is not archived still keeps its agent from automatic cleanup) and every group of a start it holds (the
   *  host still settles a queued start whose group went quiet). */
  private async tabState(tx: Transaction, cached: CacheView, tabId: string, machineId: string): Promise<SuperTabState> {
    const [light, machines] = await Promise.all([cached.get(tabId, `host:state:${machineId}`, 'main',
      // On a miss, one snapshot of what the host's rows are built from, tried again when a lock it waits for is held (retry.ts).
      () => retryTransient(() => retryStaleIndex(() => this.db.$transaction(t => this.hostParts(t, tabId, machineId))))),
      readMachines(tx, cached, tabId)])
    return parts.reassemble({ ...light, machines }, { share: true })
  }

  private async hostParts(tx: Transaction, tabId: string, machineId: string) {
    const [agents, starts] = await Promise.all([
      tx.swarmAgent.findMany({ where: { tabId, machineId, deleted: false }, select: { key: true } }),
      tx.swarmStart.findMany({ where: { tabId, machineId, deleted: false, finishedAt: null }, select: { conversationId: true } }),
    ])
    const groupIds = [...new Set(starts.map(s => s.conversationId))]
    // A pool lists every conversation of a project it has a start in.
    const projectIds = groupIds.length ? [...new Set((await tx.swarmGroup.findMany({ where: { tabId, key: { in: groupIds } }, select: { projectId: true } }))
      .map(g => g.projectId ?? 'lead'))] : []
    // Light conversations (parts/light.ts), and only those host rows read: its agents' (dormant ones too, for `active`),
    // the Lead conversations, running work (assignments, attention, stop requests), and its starts' and their projects'.
    return parts.loadLight(tx, tabId, { groups: 'working', agentIds: agents.map(a => a.key), groupIds, projectIds, machines: false })
  }

  /**
   * The signature of everything host rows are built from, read from version columns only (no part data): the head,
   * members, agents and starts by their data stamps, machines by their settings marker (not their readings), and
   * conversations by their host-fields digest and dormancy (a post leaves both). Null while a conversation has no digest
   * yet: a missing digest counts as changed.
   */
  private async inputs(tx: Transaction, tabId: string): Promise<string | null> {
    const live = { tabId, deleted: false }, stamp = { key: true, changedAt: true } as const
    const [head, members, agents, starts, machines, digests] = await Promise.all([
      tx.swarmHead.findUnique({ where: { id: `${tabId}:head` }, select: { changedAt: true } }),
      tx.swarmMember.findMany({ where: live, select: stamp }), tx.swarmAgent.findMany({ where: live, select: stamp }),
      tx.swarmStart.findMany({ where: live, select: stamp }),
      tx.swarmMachine.findMany({ where: live, select: { key: true, hostChangedAt: true } }),
      // Every conversation's digest (which carries its id) and dormancy, in key order, as one string: about 23 bytes each.
      tx.swarmGroup.aggregateRaw({ pipeline: [{ $match: { tabId, deleted: false } }, { $sort: { key: 1 } },
        { $group: { _id: null, missing: { $sum: { $cond: [{ $ifNull: ['$hostDigest', false] }, 0, 1] } },
          all: { $push: { $concat: [{ $ifNull: ['$hostDigest', ''] }, { $cond: ['$dormant', '1', '0'] }] } } } },
        { $project: { _id: 0, missing: 1, all: { $reduce: { input: '$all', initialValue: '', in: { $concat: ['$$value', '$$this'] } } } } }] }),
    ])
    const groups = (digests as unknown as Array<{ missing: number; all: string }>)[0] ?? { missing: 0, all: '' }
    if (!head || groups.missing) return null
    const keyed = <T extends { key: string }>(rows: T[]) => rows.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    return createHash('sha256').update(JSON.stringify([head.changedAt, keyed(members), keyed(agents), keyed(starts), keyed(machines), groups.all]))
      .digest('base64url').slice(0, ROW_HASH)
  }

  private async lookups(tx: Transaction, state: SuperTabState, teams: Array<{ machineId: string }>, grants: GrantReads): Promise<HostLookups> {
    const people = state.people.length ? await tx.user.findMany({ where: { id: { in: state.people.map(p => p.id) }, autonomousEnv: state.environment }, select: { id: true, email: true } }) : []
    const confidential = await confidentialSessions(tx, state.agents.map(a => a.id), state.id)
    return { people, confidential, teams, githubApp: !!this.options.githubApp, agentGrant: target => this.store.agentGrant(tx, state, target, grants) }
  }

  /** Swarms whose record of this machine changed since the cursor and that no longer list it. */
  private async removed(tx: Transaction, autonomousEnv: string, machineId: string, since: number, listed: Set<string>): Promise<string[]> {
    const rows = await tx.swarmMachine.findMany({ where: { machineId, hostChangedAt: { gt: new Date(since) } }, select: { tabId: true } })
    const gone = [...new Set(rows.map(r => r.tabId))].filter(id => !listed.has(id))
    if (!gone.length) return []
    return swarmsIn(tx, autonomousEnv, gone)
  }
}
