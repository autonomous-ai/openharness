/**
 * The read API by parts (design section 4; shapes in contract.ts). Every read takes its time `T0` before any query and
 * makes the next cursor from it, so a write that commits late, inside the overlap, is still seen by the next poll.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../lib/ssoAuth.js'
import { isTeamSession, TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE } from '../../lib/teamSession.js'
import { author, fail, type Actor, type AgentStart } from '../model.js'
import { mentionsWaiting } from '../mentions.js'
import { transaction, type SuperTabStore } from '../store.js'
import { migrateSwarm } from '../migration/migrate.js'
import * as parts from '../parts/index.js'
import type { SwarmParts } from '../parts/index.js'
import { canReadGroup } from '../projects.js'
import { READ_FORMAT, SWARM_MIGRATING, type Changes, type DormantGroups, type FirstLoad, type OneGroup, type SwarmList } from './contract.js'
import { cursorFor, readCursor } from './cursor.js'
import { changesFor } from './changes.js'
import { envelope, groupView, readerView, type ReaderView } from './views.js'
import { decodeDormantPage, encodeDormantPage } from './dormantPage.js'

type Transaction = Prisma.TransactionClient
type LoadOptions = Parameters<typeof parts.loadActive>[2]
interface Read { parts: SwarmParts; actor: Actor; view: ReaderView; lastChangedAt: number | null }

export class SwarmReads {
  private readonly now: () => number
  constructor(private readonly db: PrismaClient, private readonly store: SuperTabStore, private readonly options: { now?: () => number; githubApp?: boolean } = {}) {
    this.now = options.now ?? Date.now
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
      let read = await this.load(tx, user, tabId, asAgentId, t0, { includeRecentStarts: true })
      const from = readCursor(cursor, read.parts.visibilityEpoch, t0)
      if ('reload' in from) return from
      const changed = (await parts.loadChanged(tx, [tabId], new Date(from.since))).get(tabId) ?? []
      // A changed start whose group went dormant is read against that group, so its readers alone learn of it.
      const held = new Set(read.parts.groups.map(g => g.key))
      const dormant = [...new Set(changed.flatMap(p => p.kind === 'start' ? [(p.data as AgentStart).request.conversationId] : []))].filter(id => !held.has(id))
      if (dormant.length) read = await this.load(tx, user, tabId, asAgentId, t0, { includeRecentStarts: true, groupIds: dormant })
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

  async list(user: AuthUser, after?: string): Promise<SwarmList> {
    if (isTeamSession(user)) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
    const rows = await this.db.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, memberIds: { has: user.sub },
      ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 101, select: { id: true, ownerId: true, format: true } })
    const page = rows.slice(0, 100)
    // A Swarm not yet in parts is migrated when it is opened; until then the list names it from its old row.
    const legacy = await this.db.superTab.findMany({ where: { id: { in: page.filter(r => r.format !== 2).map(r => r.id) } }, select: { id: true, state: true } })
    const ids = page.filter(r => r.format === 2).map(r => r.id)
    const [heads, newest] = await transaction(this.db, tx => Promise.all([parts.loadChanged(tx, ids, new Date(0), ['head']), parts.lastChangedAt(tx, ids)]))
    return { tabs: page.map(row => {
      const head = (heads.get(row.id)?.[0]?.data ?? legacy.find(l => l.id === row.id)?.state) as { name: string; paused: boolean }
      return { id: row.id, name: head.name, ownerId: row.ownerId, paused: head.paused, lastChangedAt: newest.get(row.id) ?? null }
    }), next: rows.length > 100 ? page.at(-1)!.id : null }
  }

  /** Runs a read; a Swarm still in one row is migrated first, as a safety net for one the job did not see (design 6.1),
   *  and answers 503 while that cannot be done. The store's own loader refuses a Swarm not in parts. */
  private async read<T>(user: AuthUser, tabId: string, body: (tx: Transaction) => Promise<T>): Promise<T> {
    const row = await this.db.superTab.findFirst({ where: { id: tabId, autonomousEnv: user.autonomousEnv }, select: { format: true } })
    if (row && row.format !== 2 && !(await migrateSwarm(this.db, tabId)).ok) fail(SWARM_MIGRATING.code, SWARM_MIGRATING.message, SWARM_MIGRATING.status)
    return transaction(this.db, async tx => { await this.store.row(tx, user, tabId); return body(tx) })
  }

  private async load(tx: Transaction, user: AuthUser, tabId: string, asAgentId: string | undefined, t0: number, opts: LoadOptions): Promise<Read> {
    const loaded = await parts.loadActive(tx, tabId, opts)
    const state = parts.reassemble(loaded)
    const actor = await this.store.actor(tx, user, state, asAgentId)
    const [teamMachines, mentions, newest] = await Promise.all([
      state.machines?.length ? this.store.teamMachines(tx, state) : [],
      actor.kind === 'person' ? mentionsWaiting(tx, tabId, state, actor, t0) : undefined,
      parts.lastChangedAt(tx, [tabId]),
    ])
    return { parts: loaded, actor, lastChangedAt: newest.get(tabId) ?? null,
      view: readerView(loaded, actor, t0, { teamMachines, ...(mentions !== undefined ? { mentionsWaiting: mentions } : {}) }) }
  }
}
