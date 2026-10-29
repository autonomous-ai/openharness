/**
 * The read API by parts (design section 4; shapes in contract.ts). Every read takes its time `T0` before any query and
 * makes the next cursor from it, so a write that commits late, inside the overlap, is still seen by the next poll.
 */
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../lib/ssoAuth.js'
import { isTeamSession, TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE } from '../../lib/teamSession.js'
import { author, fail, groupWithoutMachines, isLeads, seenMachineIds, visibleState, type Actor, type AgentStart, type SuperTabState } from '../model.js'
import { waitingMentions } from '../mentions.js'
import { decisionsWaiting } from '../decisions.js'
import { readMarks, writeReadMark } from '../readMarks.js'
import type { SuperTabStore } from '../store.js'
import { transaction } from '../store.js'
import type { CacheView } from '../cache.js'
import { readChanged, readLastChangedAt, readLight, readParts } from '../cachedReads.js'
import { migrateSwarm } from '../migration/migrate.js'
import * as parts from '../parts/index.js'
import type { GroupData, Part, SwarmParts } from '../parts/index.js'
import { canReadGroup, readProject } from '../projects.js'
import { isBuddyReader } from '../buddies.js'
import { workspacesRequired } from '../workspaceStore.js'
import type { Leaderboard } from '../leaderboard/contract.js'
import { profileNames, readableWeek, recentDormantGroups } from '../leaderboard/read.js'
import { LEDGER_WEEKS } from '../leaderboard/record.js'
import { leaderboard } from '../leaderboard/stats.js'
import { WEEK_MS } from '../leaderboard/week.js'
import { READ_FORMAT, SWARM_MIGRATING, type Changes, type Derived, type DormantGroups, type FirstLoad, type OneGroup, type SwarmList } from './contract.js'
import { AvatarLinks } from '../avatarLinks.js'
import { cursorFor, readCursor } from './cursor.js'
import { changesFor } from './changes.js'
import { envelope, groupView, readerView, seenIn, type ReaderView } from './views.js'
import { decodeDormantPage, encodeDormantPage } from './dormantPage.js'
import { memberSwarms } from '../swarmRows.js'

type LoadOptions = NonNullable<Parameters<typeof parts.loadActive>[2]> & Pick<NonNullable<Parameters<typeof parts.loadLight>[2]>, 'groups'>
type Loader = (view: CacheView, tabId: string, opts: LoadOptions) => Promise<SwarmParts>
interface Read { parts: SwarmParts; actor: Actor; view: ReaderView; lastChangedAt: number | null }
/** How long one Swarm's machine lookups below are reused: machines report every 15 s anyway (Diego's review, item 5, 2026-10-28). */
const MACHINE_READS_MS = 15_000
type MachineReads = [teamMachines: string[], otherWorkspaceMachines: string[], machineVersions: Record<string, string>]

/** The reader's marks of the conversations they can read now, a dormant one read by id included: a mark never names a
 *  conversation the reader has lost. Only in a person's read; nothing for an agent. */
function readableMarks(read: Read, marks: Map<string, number>): Pick<Derived, 'readMarks'> {
  if (read.actor.kind !== 'person') return {}
  const shown = new Set(read.view.parts.groups.map(g => g.key))
  const readable = (id: string) => shown.has(id)
    || read.parts.groups.some(g => g.key === id && g.dormant && canReadGroup(read.view.state, read.actor, g.data!))
  return { readMarks: Object.fromEntries([...marks].filter(([id]) => readable(id))) }
}

export class SwarmReads {
  private readonly db: PrismaClient
  private readonly now: () => number
  /** Reads the store's own database, on its clock unless given one (tests). */
  constructor(private readonly store: SuperTabStore, private readonly options: { now?: () => number; githubApp?: boolean } = {}) {
    this.db = store.db
    this.now = options.now ?? store.now
    this.avatarLinks = store.avatars ? new AvatarLinks(store.avatars, store.avatarPrefix) : null
  }
  private readonly avatarLinks: AvatarLinks | null
  /** The machine lookups of each Swarm read in the last MACHINE_READS_MS, oldest first, keyed by what they depend on. */
  private readonly machineReads = new Map<string, { at: number; read: Promise<MachineReads> }>()

  async firstLoad(user: AuthUser, tabId: string, asAgentId?: string): Promise<FirstLoad> {
    const t0 = this.now()
    return this.read(user, tabId, async (tx, cached) => {
      const read = await this.load(tx, cached, user, tabId, asAgentId, t0, { includeRecentStarts: true })
      const { parts: loaded, view, lastChangedAt } = read
      return { format: READ_FORMAT, tabId, cursor: cursorFor(t0, loaded.visibilityEpoch), serverTime: t0, lastChangedAt, epoch: loaded.visibilityEpoch,
        ...(this.options.githubApp ? { githubApp: true as const } : {}), ...view.parts,
        derived: { ...await this.withAvatars(view, t0), ...readableMarks(read, await this.marksOf(tx, tabId, read.actor)) } }
    })
  }

  /** The reader's avatar links (avatarLinks.ts), only ever in a member's read: issued afresh each time, never stored. */
  private async withAvatars(view: ReaderView, now: number): Promise<Derived> {
    if (!this.avatarLinks) return view.derived
    const seen = new Set(Object.keys(view.derived.agents))
    const avatars = await this.avatarLinks.forReader(view.state, view.state.agents.filter(a => seen.has(a.id)), now)
    return Object.keys(avatars).length ? { ...view.derived, avatars } : view.derived
  }

  async changes(user: AuthUser, tabId: string, cursor: string, asAgentId?: string): Promise<Changes> {
    const t0 = this.now()
    return this.read(user, tabId, async (tx, cached) => {
      // Light (parts/light.ts): changed parts come whole from the change feed; the rest is read only to check visibility and
      // derive values: the Lead conversations, those with running work, and those a person's mentions are in (their count).
      // Open decisions count their conversations themselves (decisions.ts).
      const mentioned = asAgentId ? [] : (await tx.superTabMention.findMany({ where: { tabId, personId: user.sub }, select: { conversationId: true },
        distinct: ['conversationId'] })).map(m => m.conversationId)
      const light = { includeRecentStarts: true, groups: 'working' as const, groupIds: mentioned }
      const lightly: Loader = (view, id, opts) => readLight(tx, view, id, opts)
      let read = await this.load(tx, cached, user, tabId, asAgentId, t0, light, lightly)
      const from = readCursor(cursor, read.parts.visibilityEpoch, t0)
      if ('reload' in from) return from
      const changed = await readChanged(tx, cached, tabId, from.since)
      // A changed start whose group went dormant is read against that group, so its readers alone learn of it.
      const held = new Set(read.parts.groups.map(g => g.key))
      // So is a conversation whose read mark moved, so the mark goes only to a reader who can still read it.
      const marks = await this.marksOf(tx, tabId, read.actor, from.since)
      const unheld = [...new Set([...changed.flatMap(p => p.kind === 'start' ? [(p.data as AgentStart).request.conversationId] : []), ...marks.keys()])]
        .filter(id => !held.has(id))
      if (unheld.length) read = await this.load(tx, cached, user, tabId, asAgentId, t0, { ...light, groupIds: [...mentioned, ...unheld] }, lightly)
      return { format: READ_FORMAT, reload: false, cursor: cursorFor(t0, read.parts.visibilityEpoch), serverTime: t0, lastChangedAt: read.lastChangedAt,
        epoch: read.parts.visibilityEpoch, ...changesFor(read.view, changed, read.actor),
        derived: { ...await this.withAvatars(read.view, t0), ...readableMarks(read, marks) } }
    })
  }

  async dormant(user: AuthUser, tabId: string, page: { projectId?: string; before?: string }, asAgentId?: string): Promise<DormantGroups> {
    return this.read(user, tabId, async (tx, cached) => {
      const state = parts.reassemble(await readParts(tx, cached, tabId), { share: true })
      const actor = await this.store.actor(tx, user, state, asAgentId)
      author(state, actor)
      // A project the reader cannot read is refused before any read, or the pager reads on through all of it for nothing.
      if (page.projectId) readProject(state, actor, page.projectId)
      // A group the reader may not see never shortens a page, and the cursor names the last group it returns: one built
      // from a hidden row handed out that private chat's id and time (security review 2 of #2115). Each batch reads on from
      // the last row of the one before, by its index, as messages() does, until a page of 50 or the end.
      const readable: Part<GroupData>[] = []
      let more = false
      for (let before = page.before ? decodeDormantPage(page.before) : undefined; ;) {
        const rows = await parts.loadDormant(tx, tabId, { ...(page.projectId ? { projectId: page.projectId } : {}), ...(before ? { before } : {}) })
        for (const row of rows) {
          if (readable.length === parts.DORMANT_PAGE) { more = true; break }
          try { if (canReadGroup(state, actor, row.data!)) readable.push(row) } catch { /* its project is gone: no reader's */ }
        }
        if (more || rows.length < parts.DORMANT_PAGE) break
        const last = rows.at(-1)!
        before = { lastActivityAt: Date.parse(last.data!.lastActivityAt!), key: last.key }
      }
      const seen = readable.some(p => p.data!.task?.requires) ? seenMachineIds(visibleState(state, actor, this.now())) : new Set<string>()
      const buddy = isBuddyReader(state, actor)
      return { groups: readable.map(p => envelope(p, groupView({ ...buddy ? groupWithoutMachines(p.data!) : p.data!, dormant: true }, seen))),
        next: more ? encodeDormantPage(readable.at(-1)!) : null }
    })
  }

  async group(user: AuthUser, tabId: string, conversationId: string, asAgentId?: string): Promise<OneGroup> {
    const t0 = this.now()
    return this.read(user, tabId, async (tx, cached) => {
      const { view, parts: loaded, actor } = await this.load(tx, cached, user, tabId, asAgentId, t0, { groupIds: [conversationId] })
      const active = view.parts.groups.find(g => g.key === conversationId)
      if (active) return { group: active }
      // A dormant group is in no whole-Swarm view; it passes the same read check as on the dormant list.
      const dormant = loaded.groups.find(g => g.key === conversationId && g.dormant)
      if (dormant && canReadGroup(view.state, actor, dormant.data!)) {
        const data = isBuddyReader(view.state, actor) ? groupWithoutMachines(dormant.data!) : dormant.data!
        return { group: envelope(dormant, groupView({ ...data, dormant: true }, seenIn(view.parts))) }
      }
      return fail('NOT_FOUND', 'This conversation is unavailable.', 404)
    })
  }

  /** Moves the person's read mark in a conversation they can read forward, never past its newest message (readMarks.ts). Only a
   *  person reading as themselves has marks: an agent, or a Team session, is refused before anything is written. */
  async markRead(user: AuthUser, tabId: string, conversationId: string, sequence: number): Promise<{ sequence: number }> {
    if (isTeamSession(user)) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
    const { group } = await this.group(user, tabId, conversationId)
    const newest = group.data!.lastMessageSequence
    return { sequence: await writeReadMark(this.db, { tabId, personId: user.sub, conversationId, sequence: Math.min(sequence, newest), now: this.now() }) }
  }

  /** A person's own read marks (an agent has none), every one or those moved since `since`. */
  private async marksOf(tx: PrismaClient, tabId: string, actor: Actor, since?: number): Promise<Map<string, number>> {
    return actor.kind === 'person' ? readMarks(tx, tabId, actor.userId, since) : new Map()
  }

  /** One project's leaderboard for a week (leaderboard/stats.ts), for the people who read the project. It sums only the
   *  groups the reader may read, dormant ones of the kept weeks included, and never a private conversation. */
  async leaderboard(user: AuthUser, tabId: string, projectId: string, week?: number): Promise<Leaderboard> {
    if (isTeamSession(user)) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
    const now = this.now(), start = readableWeek(week, now)
    return this.read(user, tabId, async (tx, cached) => {
      const state = parts.reassemble(await readParts(tx, cached, tabId), { share: true })
      const actor = await this.store.actor(tx, user, state)
      readProject(state, actor, projectId)
      const dormant = await recentDormantGroups(tx, tabId, projectId, now - LEDGER_WEEKS * WEEK_MS)
      const groups = [...state.conversations.filter(g => !g.dormant), ...dormant].filter(g => !isLeads(g) && canReadGroup(state, actor, g))
      const names = await profileNames(tx, state.people.map(p => p.id))
      return leaderboard({ state, groups, machines: visibleState(state, actor, now).machines ?? [], projectId, week: start, now, names })
    })
  }

  async list(user: AuthUser, after?: string): Promise<SwarmList> {
    if (isTeamSession(user)) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
    const rows = await memberSwarms(this.db, user.autonomousEnv, user.sub, { after, limit: 101 })
    // A Swarm of a Workspace the person is no longer in is not theirs to list, even before their removal from it has run.
    const workspaceIds = [...new Set(rows.flatMap(r => r.workspaceId ? [r.workspaceId] : []))]
    const current = new Set((await this.db.swarmWorkspaceMember.findMany({ where: { workspaceId: { in: workspaceIds }, userId: user.sub, removedAt: null },
      select: { workspaceId: true } })).map(m => m.workspaceId))
    const page = rows.slice(0, 100).filter(r => r.workspaceId ? current.has(r.workspaceId) : !workspacesRequired())
    // A Swarm not yet in parts is migrated when it is opened; until then the list names it from its old row.
    const legacy = await this.db.superTab.findMany({ where: { id: { in: page.filter(r => r.format !== 2).map(r => r.id) } }, select: { id: true, state: true } })
    const ids = page.filter(r => r.format === 2).map(r => r.id)
    // Every head changed after the epoch: one read of each listed Swarm's head part.
    const [heads, newest] = await transaction(this.db, tx => Promise.all([parts.loadChanged(tx, ids, new Date(0), ['head']), parts.lastChangedAt(tx, ids)]))
    return { tabs: page.map(row => {
      const head = (heads.get(row.id)?.[0]?.data ?? legacy.find(l => l.id === row.id)?.state) as { name: string; paused: boolean }
      return { id: row.id, name: head.name, ownerId: row.ownerId, workspaceId: row.workspaceId, paused: head.paused, lastChangedAt: newest.get(row.id) ?? null }
    }), next: rows.length > 100 ? rows[99]!.id : null }
  }

  /** Runs a read, outside any transaction: its parts come through the read cache at the stamps `body` is given (cache.ts),
   *  and only the read of the base parts on a miss is a transaction (cachedReads.ts). A Swarm still in one row is migrated
   *  first, as a safety net for one the job did not see (design 6.1), and answers 503 while that cannot be done. */
  private async read<T>(user: AuthUser, tabId: string, body: (tx: PrismaClient, view: CacheView) => Promise<T>): Promise<T> {
    // The row's format only: a migrated row still holds its old state, as large as the Swarm, until the owner drops it.
    const row = await this.db.superTab.findFirst({ where: { id: tabId, autonomousEnv: user.autonomousEnv }, select: { format: true } })
    if (!row) fail('NOT_FOUND', 'This Super Tab is unavailable.', 404)
    if (row.format !== 2 && !(await migrateSwarm(this.db, tabId)).ok) fail(SWARM_MIGRATING.code, SWARM_MIGRATING.message, SWARM_MIGRATING.status)
    return body(this.db, await this.store.view([tabId]))
  }

  private async load(tx: PrismaClient, cached: CacheView, user: AuthUser, tabId: string, asAgentId: string | undefined, t0: number, opts: LoadOptions,
    loader: Loader = (view, id, named) => readParts(tx, view, id, named)): Promise<Read> {
    const loaded = await loader(cached, tabId, opts)
    const state = parts.reassemble(loaded, { share: true })
    const actor = await this.store.actor(tx, user, state, asAgentId)
    const [[teamMachines, otherWorkspaceMachines, machineVersions], counts, newest] = await Promise.all([
      this.machineLookups(state),
      actor.kind === 'person' ? Promise.all([waitingMentions(tx, tabId, state, actor, t0), decisionsWaiting(tx, tabId, state, actor)]) : undefined,
      readLastChangedAt(tx, cached, tabId),
    ])
    return { parts: loaded, actor, lastChangedAt: newest,
      view: readerView(loaded, actor, t0, { teamMachines, otherWorkspaceMachines, machineVersions,
        ...(counts ? { mentionsWaiting: counts[0].count, mentionsDigest: counts[0].digest, decisionsWaiting: counts[1].count,
          decisionsDigest: counts[1].digest } : {}) }, state) }
  }

  /** Which of the Swarm's machines are signed in as a team account, and which serve another Workspace's Swarm too (store.ts): the
   *  same answer for every reader, whose view hides what it may not see, so one lookup serves every read of the Swarm for
   *  MACHINE_READS_MS. Commands that admit work still look up afresh (store.ts executeOnce). Outside any transaction, as every read is. */
  private machineLookups(state: SuperTabState): Promise<MachineReads> {
    if (!state.machines?.length) return Promise.resolve([[], [], {}])
    const now = this.now()
    const key = JSON.stringify([state.id, state.environment, state.workspaceId ?? null, state.machines.map(m => m.machineId).sort()])
    const kept = this.machineReads.get(key)
    if (kept && now >= kept.at && now - kept.at < MACHINE_READS_MS) return kept.read
    for (const [old, entry] of this.machineReads) {
      if (now >= entry.at && now - entry.at < MACHINE_READS_MS) break
      this.machineReads.delete(old)
    }
    const entry = { at: now, read: Promise.all([this.store.machineFacts(this.db, state), this.store.otherWorkspaceMachines(this.db, state)])
      .then(([facts, other]): MachineReads => [facts.team, other, facts.versions]) }
    this.machineReads.delete(key)
    this.machineReads.set(key, entry)
    // A failed lookup is never reused.
    entry.read.catch(() => { if (this.machineReads.get(key) === entry) this.machineReads.delete(key) })
    return entry.read
  }
}
