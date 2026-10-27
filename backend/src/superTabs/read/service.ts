/**
 * The read API by parts (design section 4; shapes in contract.ts). Every read takes its time `T0` before any query and
 * makes the next cursor from it, so a write that commits late, inside the overlap, is still seen by the next poll.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../lib/ssoAuth.js'
import { isTeamSession, TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE } from '../../lib/teamSession.js'
import { author, fail, isLeads, visibleState, type Actor, type AgentStart } from '../model.js'
import { mentionsWaiting } from '../mentions.js'
import { decisionsWaiting } from '../decisions.js'
import { transaction, type SuperTabStore } from '../store.js'
import { migrateSwarm } from '../migration/migrate.js'
import * as parts from '../parts/index.js'
import type { SwarmParts } from '../parts/index.js'
import { canReadGroup, readProject } from '../projects.js'
import { orgsRequired } from '../orgStore.js'
import type { Leaderboard } from '../leaderboard/contract.js'
import { readableWeek, recentDormantGroups } from '../leaderboard/read.js'
import { LEDGER_WEEKS } from '../leaderboard/record.js'
import { leaderboard } from '../leaderboard/stats.js'
import { WEEK_MS } from '../leaderboard/week.js'
import { READ_FORMAT, SWARM_MIGRATING, type Changes, type DormantGroups, type FirstLoad, type OneGroup, type SwarmList } from './contract.js'
import { cursorFor, readCursor } from './cursor.js'
import { changesFor } from './changes.js'
import { envelope, groupView, readerView, type ReaderView } from './views.js'
import { decodeDormantPage, encodeDormantPage } from './dormantPage.js'

type Transaction = Prisma.TransactionClient
type LoadOptions = NonNullable<Parameters<typeof parts.loadActive>[2]> & Pick<NonNullable<Parameters<typeof parts.loadLight>[2]>, 'groups'>
interface Read { parts: SwarmParts; actor: Actor; view: ReaderView; lastChangedAt: number | null }

export class SwarmReads {
  private readonly db: PrismaClient
  private readonly now: () => number
  /** Reads the store's own database, on its clock unless given one (tests). */
  constructor(private readonly store: SuperTabStore, private readonly options: { now?: () => number; githubApp?: boolean } = {}) {
    this.db = store.db
    this.now = options.now ?? store.now
  }

  async firstLoad(user: AuthUser, tabId: string, asAgentId?: string): Promise<FirstLoad> {
    const t0 = this.now()
    return this.read(user, tabId, async tx => {
      const { parts: loaded, view, lastChangedAt } = await this.load(tx, user, tabId, asAgentId, t0, { includeRecentStarts: true })
      return { format: READ_FORMAT, tabId, cursor: cursorFor(t0, loaded.visibilityEpoch), serverTime: t0, lastChangedAt, epoch: loaded.visibilityEpoch,
        ...(this.options.githubApp ? { githubApp: true as const } : {}), ...view.parts, derived: view.derived }
    })
  }

  async changes(user: AuthUser, tabId: string, cursor: string, asAgentId?: string): Promise<Changes> {
    const t0 = this.now()
    return this.read(user, tabId, async tx => {
      // Light (parts/light.ts): changed parts come whole from the change feed; the rest is read only to check visibility and
      // derive values: the Lead conversations, those with running work, and those a person's mentions are in (their count).
      // Open decisions count their conversations themselves (decisions.ts).
      const mentioned = asAgentId ? [] : (await tx.superTabMention.findMany({ where: { tabId, personId: user.sub }, select: { conversationId: true },
        distinct: ['conversationId'] })).map(m => m.conversationId)
      const light = { includeRecentStarts: true, groups: 'working' as const, groupIds: mentioned }
      let read = await this.load(tx, user, tabId, asAgentId, t0, light, parts.loadLight)
      const from = readCursor(cursor, read.parts.visibilityEpoch, t0)
      if ('reload' in from) return from
      const changed = (await parts.loadChanged(tx, [tabId], new Date(from.since))).get(tabId) ?? []
      // A changed start whose group went dormant is read against that group, so its readers alone learn of it.
      const held = new Set(read.parts.groups.map(g => g.key))
      const dormant = [...new Set(changed.flatMap(p => p.kind === 'start' ? [(p.data as AgentStart).request.conversationId] : []))].filter(id => !held.has(id))
      if (dormant.length) read = await this.load(tx, user, tabId, asAgentId, t0, { ...light, groupIds: [...mentioned, ...dormant] }, parts.loadLight)
      return { format: READ_FORMAT, reload: false, cursor: cursorFor(t0, read.parts.visibilityEpoch), serverTime: t0, lastChangedAt: read.lastChangedAt,
        epoch: read.parts.visibilityEpoch, ...changesFor(read.view, changed, read.actor), derived: read.view.derived }
    })
  }

  async dormant(user: AuthUser, tabId: string, page: { projectId?: string; before?: string }, asAgentId?: string): Promise<DormantGroups> {
    return this.read(user, tabId, async tx => {
      const loaded = await parts.loadActive(tx, tabId)
      const state = parts.reassemble(loaded)
      const actor = await this.store.actor(tx, user, state, asAgentId)
      author(state, actor)
      const before = page.before ? decodeDormantPage(page.before) : undefined
      const rows = await parts.loadDormant(tx, tabId, { ...(page.projectId ? { projectId: page.projectId } : {}), ...(before ? { before } : {}) })
      const readable = rows.filter(p => { try { return canReadGroup(state, actor, p.data!) } catch { return false } })
      return { groups: readable.map(p => envelope(p, groupView({ ...p.data!, dormant: true }))),
        next: rows.length === 50 ? encodeDormantPage(rows.at(-1)!) : null }
    })
  }

  async group(user: AuthUser, tabId: string, conversationId: string, asAgentId?: string): Promise<OneGroup> {
    const t0 = this.now()
    return this.read(user, tabId, async tx => {
      const { view, parts: loaded, actor } = await this.load(tx, user, tabId, asAgentId, t0, { groupIds: [conversationId] })
      const active = view.parts.groups.find(g => g.key === conversationId)
      if (active) return { group: active }
      // A dormant group is in no whole-Swarm view; it passes the same read check as on the dormant list.
      const dormant = loaded.groups.find(g => g.key === conversationId && g.dormant)
      if (dormant && canReadGroup(view.state, actor, dormant.data!)) return { group: envelope(dormant, groupView({ ...dormant.data!, dormant: true })) }
      return fail('NOT_FOUND', 'This conversation is unavailable.', 404)
    })
  }

  /** One project's leaderboard for a week (leaderboard/stats.ts), for the people who read the project. It sums only the
   *  groups the reader may read, dormant ones of the kept weeks included, and never a private conversation. */
  async leaderboard(user: AuthUser, tabId: string, projectId: string, week?: number): Promise<Leaderboard> {
    if (isTeamSession(user)) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
    const now = this.now(), start = readableWeek(week, now)
    return this.read(user, tabId, async tx => {
      const state = parts.reassemble(await parts.loadActive(tx, tabId))
      const actor = await this.store.actor(tx, user, state)
      readProject(state, actor, projectId)
      const dormant = await recentDormantGroups(tx, tabId, projectId, now - LEDGER_WEEKS * WEEK_MS)
      const groups = [...state.conversations.filter(g => !g.dormant), ...dormant].filter(g => !isLeads(g) && canReadGroup(state, actor, g))
      return leaderboard({ state, groups, machines: visibleState(state, actor, now).machines ?? [], projectId, week: start, now })
    })
  }

  async list(user: AuthUser, after?: string): Promise<SwarmList> {
    if (isTeamSession(user)) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
    const rows = await this.db.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, memberIds: { has: user.sub },
      ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 101, select: { id: true, ownerId: true, format: true, orgId: true } })
    // A Swarm of a Team the person is no longer in is not theirs to list, even before their removal from it has run.
    const orgIds = [...new Set(rows.flatMap(r => r.orgId ? [r.orgId] : []))]
    const current = new Set((await this.db.swarmOrgMember.findMany({ where: { orgId: { in: orgIds }, userId: user.sub, removedAt: null },
      select: { orgId: true } })).map(m => m.orgId))
    const page = rows.slice(0, 100).filter(r => r.orgId ? current.has(r.orgId) : !orgsRequired())
    // A Swarm not yet in parts is migrated when it is opened; until then the list names it from its old row.
    const legacy = await this.db.superTab.findMany({ where: { id: { in: page.filter(r => r.format !== 2).map(r => r.id) } }, select: { id: true, state: true } })
    const ids = page.filter(r => r.format === 2).map(r => r.id)
    // Every head changed after the epoch: one read of each listed Swarm's head part.
    const [heads, newest] = await transaction(this.db, tx => Promise.all([parts.loadChanged(tx, ids, new Date(0), ['head']), parts.lastChangedAt(tx, ids)]))
    return { tabs: page.map(row => {
      const head = (heads.get(row.id)?.[0]?.data ?? legacy.find(l => l.id === row.id)?.state) as { name: string; paused: boolean }
      return { id: row.id, name: head.name, ownerId: row.ownerId, orgId: row.orgId, paused: head.paused, lastChangedAt: newest.get(row.id) ?? null }
    }), next: rows.length > 100 ? rows[99]!.id : null }
  }

  /** Runs a read; a Swarm still in one row is migrated first, as a safety net for one the job did not see (design 6.1),
   *  and answers 503 while that cannot be done. The store's own loader refuses a Swarm not in parts. */
  private async read<T>(user: AuthUser, tabId: string, body: (tx: Transaction) => Promise<T>): Promise<T> {
    // The row's format only: a migrated row still holds its old state, as large as the Swarm, until the owner drops it.
    const row = await this.db.superTab.findFirst({ where: { id: tabId, autonomousEnv: user.autonomousEnv }, select: { format: true } })
    if (!row) fail('NOT_FOUND', 'This Super Tab is unavailable.', 404)
    if (row.format !== 2 && !(await migrateSwarm(this.db, tabId)).ok) fail(SWARM_MIGRATING.code, SWARM_MIGRATING.message, SWARM_MIGRATING.status)
    return transaction(this.db, body)
  }

  private async load(tx: Transaction, user: AuthUser, tabId: string, asAgentId: string | undefined, t0: number, opts: LoadOptions,
    loader: (tx: Transaction, tabId: string, opts: LoadOptions) => Promise<SwarmParts> = parts.loadActive): Promise<Read> {
    const loaded = await loader(tx, tabId, opts)
    const state = parts.reassemble(loaded)
    const actor = await this.store.actor(tx, user, state, asAgentId)
    const [teamMachines, otherOrgMachines, counts, newest] = await Promise.all([
      state.machines?.length ? this.store.teamMachines(tx, state) : [],
      state.machines?.length ? this.store.otherOrgMachines(tx, state) : [],
      actor.kind === 'person' ? Promise.all([mentionsWaiting(tx, tabId, state, actor, t0), decisionsWaiting(tx, tabId, state, actor)]) : undefined,
      parts.lastChangedAt(tx, [tabId]),
    ])
    return { parts: loaded, actor, lastChangedAt: newest.get(tabId) ?? null,
      view: readerView(loaded, actor, t0, { teamMachines, otherOrgMachines, ...(counts ? { mentionsWaiting: counts[0], decisionsWaiting: counts[1] } : {}) }) }
  }
}
