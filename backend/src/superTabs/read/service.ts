/**
 * The read API by parts (design section 4; shapes in contract.ts). Every read takes its time `T0` before any query and
 * makes the next cursor from it, so a write that commits late, inside the overlap, is still seen by the next poll.
 */
import { startsOfRule } from '../cachePatch.js'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../lib/ssoAuth.js'
import { agentOnly, author, fail, isLeads, seenMachineIds, stableId, SuperTabError, visibleState, type Actor, type AgentStart, type Conversation, type SuperTabState } from '../model.js'
import { logger } from '../../utils/logger.js'
import { lowerReadMark, readMarkRows, readThreadMarks, writeReadMark, writeThreadMark, type ReadMarkRow } from '../readMarks.js'
import { readChatSettings, writeChatSetting, type NotifyLevel } from '../chatSettings.js'
import { deliveredCopies } from '../pageReads.js'
import { readBy } from '../parts/indexed.js'
import type { SuperTabStore } from '../store.js'
import { transaction } from '../store.js'
import { sizeOf, type CacheView } from '../cache.js'
import { readAccess, readChanged, readLastChangedAt, readLastChangedAts, readLight, readLightGroups, readParts } from '../cachedReads.js'
import * as parts from '../parts/index.js'
import type { GroupData, Part, SwarmParts } from '../parts/index.js'
import { canReadGroup, canReadProject, projectsOf, readConversation, readProject } from '../projects.js'
import type { Leaderboard } from '../leaderboard/contract.js'
import { profileNames, readableWeek, recentDormantGroups, weeklyBoard } from '../leaderboard/read.js'
import { LEDGER_WEEKS } from '../leaderboard/record.js'
import type { PeriodName } from '../leaderboard/rolling.js'
import { leaderboard } from '../leaderboard/stats.js'
import { WEEK_MS } from '../leaderboard/week.js'
import { derivedEtag, marksOf } from './derivedEtag.js'
import { READ_FORMAT, type Changes, type Derived, type ReaderMarks, type MachineReadings, type DormantGroups, type FirstLoad, type OneGroup, type SwarmList } from './contract.js'
import { cursorFor, readCursor } from './cursor.js'
import { changesFor } from './changes.js'
import { envelope, groupView, readerView, seenIn, type ReaderView } from './views.js'
import { decodeDormantPage, encodeDormantPage } from './dormantPage.js'
import { ServedTops } from './servedTops.js'
import { memberSwarms } from '../swarmRows.js'
import { isPersonalSwarm } from '../deletion.js'

type LoadOptions = NonNullable<Parameters<typeof parts.loadActive>[2]>
type Loader = (view: CacheView, tabId: string, opts: LoadOptions) => Promise<SwarmParts>
interface Read { parts: SwarmParts; actor: Actor; view: ReaderView; lastChangedAt: number | null }
/** What the group rows one-group reads keep may take, counted as their JSON size (SwarmReads.groupRows). */
export const GROUP_ROWS_BYTES = 8 * 1024 * 1024
/** How long one Swarm's machine lookups below are reused: machines report every 15 s anyway (Diego's review, item 5, 2026-10-28). */
const MACHINE_READS_MS = 15_000
/** The format and deletion metadata can be reused briefly: a deletion takes effect on each pod within this window. */
export const SWARM_ROW_READS_MS = 3_000
const MAX_SWARM_ROW_READS = 2_000
type SwarmRow = { format: number | null; deletedAt: Date | null }
type SwarmRowRead = { at: number; read: Promise<SwarmRow | null> }
type MachineReads = Record<string, string>

/** The conversations the reader can read now, a dormant one read by id included. */
function readableGroups(read: Read): Set<string> {
  return new Set([...read.view.parts.groups.map(g => g.key),
    ...read.parts.groups.filter(g => g.dormant && canReadGroup(read.view.state, read.actor, g.data!)).map(g => g.key)])
}

/** The reader's marks of the conversations and threads they can read now: a mark never names a conversation the reader has
 *  lost. Only in a person's read; nothing for an agent. A read with no thread marks says none (`threadMarks` absent), and one
 *  with no mark their Mark unread moved last none either (`unreadMarks` absent). */
function readableMarks(read: Read, marks: ReadMarkRow[], threads: Map<string, Map<string, number>>, settings: Map<string, NotifyLevel> = new Map()):
  Pick<Derived, 'readMarks' | 'unreadMarks' | 'threadMarks' | 'chatSettings'> {
  if (read.actor.kind !== 'person') return {}
  const readable = readableGroups(read)
  const kept = marks.filter(mark => readable.has(mark.conversationId))
  const unreadMarks = Object.fromEntries(kept.filter(mark => mark.lowered).map(mark => [mark.conversationId, mark.sequence]))
  const threadMarks = Object.fromEntries([...threads].filter(([id]) => readable.has(id)).map(([id, held]) => [id, Object.fromEntries(held)]))
  const chatSettings = Object.fromEntries([...settings].filter(([id]) => readable.has(id)))
  return { readMarks: Object.fromEntries(kept.map(mark => [mark.conversationId, mark.sequence])), ...(Object.keys(unreadMarks).length ? { unreadMarks } : {}),
    ...(Object.keys(threadMarks).length ? { threadMarks } : {}), ...(Object.keys(chatSettings).length ? { chatSettings } : {}) }
}

/** A reply's `derived` with its etag, or only the reader's marks when `held` is still the etag of the summary (task #2906). */
function stamped(derived: Derived): { derived: Derived; derivedEtag: string }
function stamped(derived: Derived, held: string | undefined): { derived: Derived | ReaderMarks; derivedEtag: string; derivedUnchanged?: true }
function stamped(derived: Derived, held?: string) {
  const etag = derivedEtag(derived)
  return held === etag ? { derived: marksOf(derived), derivedEtag: etag, derivedUnchanged: true as const } : { derived, derivedEtag: etag }
}


/** A change poll's light base (parts/light.ts): the same for every reader of a Swarm, so one load per stamp serves them all. */
const LIGHT = { groups: 'working' } as const

/** `loaded` with these conversations too, never one it holds already. */
const withGroups = (loaded: SwarmParts, extra: Part<GroupData>[]): SwarmParts => {
  if (!extra.length) return loaded
  const held = new Set(loaded.groups.map(g => g.key))
  return { ...loaded, groups: [...loaded.groups, ...extra.filter(g => !held.has(g.key))] }
}

/** `loaded` with these starts too: a change poll's own (SwarmReads.pollStarts), never one it holds already. */
const withStarts = (loaded: SwarmParts, extra: Part<AgentStart>[]): SwarmParts => {
  if (!extra.length) return loaded
  const held = new Set(loaded.starts.map(s => s.key))
  return { ...loaded, starts: [...loaded.starts, ...extra.filter(s => !held.has(s.key))] }
}

export class SwarmReads {
  private readonly db: PrismaClient
  private readonly now: () => number
  /** Reads the store's own database, on its clock unless given one (tests). */
  constructor(private readonly store: SuperTabStore, options: { now?: () => number } = {}) {
    this.db = store.db
    this.now = options.now ?? store.now
    this.servedTops = new ServedTops(store.db)
  }
  /** Each project chat's newest main row people read, as readers are served it (servedTops.ts, #2742). */
  private readonly servedTops: ServedTops
  /** The machine lookups of each Swarm read in the last MACHINE_READS_MS, oldest first, keyed by what they depend on. */
  private readonly machineReads = new Map<string, { at: number; read: Promise<MachineReads> }>()
  /** The small format/deletion row for each Swarm, held briefly per process. */
  private readonly swarmRows = new Map<string, SwarmRowRead>()

  async firstLoad(user: AuthUser, tabId: string, asAgentId?: string): Promise<FirstLoad> {
    const t0 = this.now()
    return this.read(user, tabId, async (tx, cached) => {
      const read = await this.load(tx, cached, user, tabId, asAgentId, t0, { includeRecentStarts: true })
      const { parts: loaded, view, lastChangedAt } = read
      return { format: READ_FORMAT, tabId, cursor: cursorFor(t0, loaded.visibilityEpoch), serverTime: t0, lastChangedAt, epoch: loaded.visibilityEpoch,
        ...view.parts,
        ...stamped({ ...view.derived, ...readableMarks(read, await this.marksOf(tx, tabId, read.actor),
          await this.threadMarksOf(tx, tabId, read.actor), await this.settingsOf(tx, tabId, read.actor)) }) }
    })
  }

  /**
   * The finished starts a change poll needs besides the unfinished ones it loaded: those changed since its cursor, as the
   * change feed read them (it sends them as a first load shows them), and those whose harness a machine record still lists
   * (model.ts visibleState shows a reader a listed harness only beside an agent or start it may read). Every other finished
   * start leaves the reply as it was: a poll sends only changed parts. The second read is by the (tabId, agentId) index and
   * held at the Swarm's main stamp, under the harnesses it names.
   */
  private async pollStarts(tx: PrismaClient, cached: CacheView, tabId: string, base: SwarmParts, changed: Part[]): Promise<Part<AgentStart>[]> {
    const held = new Set(base.starts.map(s => s.key))
    const fresh = (changed.filter(p => p.kind === 'start' && !p.deleted && !held.has(p.key)) as Part<AgentStart>[])
    const agentOf = (s: Part<AgentStart>) => s.data!.harnessId ? stableId(s.data!.request.machineId, s.data!.harnessId) : null
    const covered = new Set([...base.starts, ...fresh].map(agentOf))
    const listed = [...new Set(base.machines.flatMap(m => {
      const pool = m.data?.contribution, seen = pool?.observation
      if (!pool || !seen) return []
      return [...seen.runningHarnessIds, ...seen.stoppedHarnessIds, ...Object.keys(seen.harnessProgress ?? {}), ...(seen.stoppedReservations ?? []).map(r => r.harnessId)]
        .map(harnessId => stableId(pool.machineId, harnessId))
    }))].filter(id => !covered.has(id)).sort()
    // Patched from each change (cachePatch.ts startsOfRule, spec 2026-11-02 poll cost), not loaded again after every bump.
    const named = listed.length ? await cached.get(tabId, `startsOf:${JSON.stringify(listed)}`, 'main', () => parts.loadStartsOfAgents(tx, tabId, listed),
      startsOfRule(listed)) : []
    const taken = new Set([...held, ...fresh.map(s => s.key)])
    return [...fresh, ...named.filter(s => !taken.has(s.key))]
  }

  /** Every machine the reader sees, whole: what a client that asks for lines in its changes reads when it needs more than liveness. */
  async machineReadings(user: AuthUser, tabId: string, asAgentId?: string): Promise<MachineReadings> {
    const t0 = this.now()
    return this.read(user, tabId, async (tx, cached) => {
      const base = await readLight(tx, cached, tabId, LIGHT)
      const read = await this.load(tx, cached, user, tabId, asAgentId, t0, {}, async () => base)
      return { format: READ_FORMAT, serverTime: t0, machines: read.view.parts.machines }
    })
  }

  /** `derivedEtag`: the etag of the summary the client holds (derivedEtag.ts); while it still matches, the reply leaves the
   *  summary out and sends only the reader's moved marks. */
  async changes(user: AuthUser, tabId: string, cursor: string, asAgentId?: string,
    options: { lightMachines?: boolean; derivedEtag?: string } = {}): Promise<Changes> {
    const t0 = this.now()
    return this.read(user, tabId, async (tx, cached) => {
      // Light (parts/light.ts): changed parts come whole from the change feed; the rest is read only to check visibility and
      // derive values. The base is one per Swarm and stamp, whoever reads: the Lead conversations, running work, unfinished
      // starts and the like, and no progress parts (the feed sends changed ones).
      const base = await readLight(tx, cached, tabId, LIGHT)
      const from = readCursor(cursor, base.visibilityEpoch, t0)
      // Reloading readers still pass the access check first, as every read does.
      if ('reload' in from) { await this.load(tx, cached, user, tabId, asAgentId, t0, {}, async () => base); return from }
      // Without asAgentId the reader is a person (store.ts actor), whose marks moved since the cursor go out with this reply.
      const person = asAgentId ? null : user.sub
      const [changed, marks, threadMarks, settings] = await Promise.all([readChanged(tx, cached, tabId, from.since),
        person ? readMarkRows(tx, tabId, person, from.since) : [],
        person ? readThreadMarks(tx, tabId, person, from.since) : new Map<string, Map<string, number>>(),
        person ? readChatSettings(tx, tabId, person, from.since) : new Map<string, NotifyLevel>()])
      // Starts: only unfinished ones whole in the base, then the poll's own.
      const extra = await this.pollStarts(tx, cached, tabId, base, changed)
      // Each reader's own conversations, held one by one (cachedReads.ts readLightGroups): those its starts are in, so a start the poll sends or a machine still lists is
      // read against its conversation, quiet or not, and its readers alone learn of it. So is a conversation whose read mark
      // moved, so the mark goes only to a reader who can still read it.
      const held = new Set(base.groups.map(g => g.key))
      const named = [...new Set([...[...changed.filter(p => p.kind === 'start'), ...extra].map(p => (p.data as AgentStart).request.conversationId),
        ...marks.map(mark => mark.conversationId), ...threadMarks.keys(), ...settings.keys()])].filter(id => !held.has(id))
      const read = await this.load(tx, cached, user, tabId, asAgentId, t0, {},
        async () => withStarts(withGroups(base, await readLightGroups(tx, cached, tabId, named)), extra))
      const sent = changesFor(read.view, changed, read.actor, options.lightMachines ? { since: from.since } : undefined)
      // A changed project chat comes whole from the change feed, with its stored newest main row (servedTops.ts).
      if (!asAgentId) sent.groups = await this.servedTops.served(tabId, read.view.state, sent.groups)
      return { format: READ_FORMAT, reload: false, cursor: cursorFor(t0, read.parts.visibilityEpoch), serverTime: t0, lastChangedAt: read.lastChangedAt,
        epoch: read.parts.visibilityEpoch, ...sent,
        ...stamped({ ...read.view.derived, ...readableMarks(read, marks, threadMarks, settings) }, options.derivedEtag) }
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
      return { groups: readable.map(p => envelope(p, groupView({ ...p.data!, dormant: true }, seen))),
        next: more ? encodeDormantPage(readable.at(-1)!) : null }
    })
  }

  /** One conversation by id as the reader may read it (design 4.5). Identical reads in flight on this process share one answer:
   *  the same sign-in, agent, Swarm and conversation get the same one (task #2875: many agents' hosts may ask at once). */
  async group(user: AuthUser, tabId: string, conversationId: string, asAgentId?: string): Promise<OneGroup> {
    const key = JSON.stringify([tabId, conversationId, asAgentId ?? null, user])
    const running = this.groupReads.get(key)
    if (running) return running
    const read = this.oneGroup(user, tabId, conversationId, asAgentId).finally(() => this.groupReads.delete(key))
    this.groupReads.set(key, read)
    return read
  }
  /** The one-group reads running now, by everything their answer depends on (group). */
  private readonly groupReads = new Map<string, Promise<OneGroup>>()
  /** The group rows one-group reads read last, by Swarm and key, least recently read first, within GROUP_ROWS_BYTES: the
   *  next read of one asks for its data only when its version moved (parts/load.ts loadGroupUnless). */
  private readonly groupRows = new Map<string, Part<GroupData>>()
  private groupRowBytes = 0
  private keepGroupRow(row: string, part: Part<GroupData> | null): void {
    const old = this.groupRows.get(row)
    if (old) { this.groupRows.delete(row); this.groupRowBytes -= sizeOf(old) }
    if (part) { this.groupRows.set(row, part); this.groupRowBytes += sizeOf(part) }
    for (const [oldest, held] of this.groupRows) {
      if (this.groupRowBytes <= GROUP_ROWS_BYTES) break
      this.groupRows.delete(oldest)
      this.groupRowBytes -= sizeOf(held)
    }
  }

  /**
   * One conversation from its own row by key and the parts its read check reads: the head, members and agents (cachedReads.ts
   * readAccess), and for an agent stored with no project its active conversations (agentProjectId). Never the whole Swarm: its
   * cached base and machines were refreshed from the Swarm's group, machine and progress feeds on every pod at every stamp a read met, ~1.33 GB in two minutes of these reads on prod (task
   * #2875). canReadGroup reads no Lead conversation here (ledProject): a group with an audience is a closed Chat with PM, or
   * an agent's 1:1 chat. It answers as readGroup does (integration/superTabOneGroup.test.ts compares
   * every reader of every group). A task naming required machines goes to readGroup: which machines its reader sees depends
   * on every agent's project; so does an awake group stored without a number, which a whole read numbers after every other.
   */
  private async oneGroup(user: AuthUser, tabId: string, conversationId: string, asAgentId?: string): Promise<OneGroup> {
    const answer = await this.read(user, tabId, async (tx, cached): Promise<OneGroup | null> => {
      const row = `${tabId}\u0000${conversationId}`
      const [access, found] = await Promise.all([readAccess(tx, cached, tabId), parts.loadGroupUnless(tx, tabId, conversationId, this.groupRows.get(row))])
      this.keepGroupRow(row, found)
      if (found?.data?.task?.requires?.machines?.length) return null
      // An awake group stored without a number (111 on prod, 11-04) is numbered by a whole read after every other one
      // (model.ts numberConversations, in visibleState): the whole read answers it. A project's chat and Leads have none.
      if (found && !found.dormant && found.data!.number == null && !isLeads(found.data!)
        && !projectsOf(parts.reassemble({ ...access, groups: [], machines: [], starts: [], progress: [] }, { share: true })).some(p => p.leadConversationId === found.key)) return null
      const target = asAgentId ? access.agents.find(a => a.key === asAgentId && !a.deleted)?.data : undefined
      const context = target && !target.projectId ? await parts.loadLightGroups(tx, tabId, 'agents', { agentIds: { $in: [target.id] }, dormant: false }) : []
      // The conversation itself whole; another only as the light row the checks read, once.
      const held = new Set(found ? [found.key] : [])
      const groups = [...found ? [found] : [], ...context.filter(g => !held.has(g.key) && !!held.add(g.key))]
      const state = parts.reassemble({ ...access, groups, machines: [], starts: [], progress: [] }, { share: true })
      const actor = await this.store.actor(tx, user, state, asAgentId)
      author(state, actor)
      const unavailable = (): never => fail('NOT_FOUND', 'This conversation is unavailable.', 404)
      if (!found) return unavailable()
      // A quiet group passes the same read check as on the dormant list. No required machines here, so no reader's view of
      // machines changes what it shows (model.ts withSeenRequirement).
      if (found.dormant) {
        if (!canReadGroup(state, actor, found.data!)) return unavailable()
        return { group: envelope(found, groupView({ ...found.data!, dormant: true }, new Set())) }
      }
      // An awake one as a whole-Swarm read lists it (views.ts readerView): a kind this release knows, never the removed Leads.
      const group = state.conversations.find(c => c.id === conversationId)
      if (!group || isLeads(group) || !canReadGroup(state, actor, group)) return unavailable()
      const one = envelope(found, groupView(group, new Set()))
      return { group: actor.kind === 'person' ? (await this.servedTops.served(tabId, state, [one]))[0]! : one }
    })
    return answer ?? { group: (await this.readGroup(user, tabId, conversationId, asAgentId)).group }
  }

  /** One conversation the reader can read, with the Swarm's state it was checked against. */
  private async readGroup(user: AuthUser, tabId: string, conversationId: string, asAgentId?: string): Promise<OneGroup & { state: SuperTabState }> {
    const t0 = this.now()
    return this.read(user, tabId, async (tx, cached) => {
      const { view, parts: loaded, actor } = await this.load(tx, cached, user, tabId, asAgentId, t0, { groupIds: [conversationId] })
      const active = view.parts.groups.find(g => g.key === conversationId)
      if (active) return { group: active, state: view.state }
      // A dormant group is in no whole-Swarm view; it passes the same read check as on the dormant list.
      const dormant = loaded.groups.find(g => g.key === conversationId && g.dormant)
      if (dormant && canReadGroup(view.state, actor, dormant.data!)) {
        return { group: envelope(dormant, groupView({ ...dormant.data!, dormant: true }, seenIn(view.parts))), state: view.state }
      }
      return fail('NOT_FOUND', 'This conversation is unavailable.', 404)
    })
  }

  /** Moves the person's read mark in a conversation they can read forward, never past its newest message (readMarks.ts). Only a
   *  person reading as themselves has marks: an agent is refused before anything is written. */
  async markRead(user: AuthUser, tabId: string, conversationId: string, sequence: number): Promise<{ sequence: number }> {
    const { group } = await this.readGroup(user, tabId, conversationId)
    const next = Math.min(sequence, group.data!.lastMessageSequence)
    return { sequence: await writeReadMark(this.db, { tabId, personId: user.sub, conversationId, sequence: next, now: this.now() }) }
  }

  /** The person's Mark unread from the message at `sequence`: their mark of a conversation they can read goes to just before it,
   *  never forward (readMarks.ts lowerReadMark), and never past the conversation's newest message. Checked as markRead: only a
   *  person reading as themselves, and every chat they cannot read is the same refusal. A reply only in a thread keeps its thread's
   *  mark. */
  async markUnread(user: AuthUser, tabId: string, conversationId: string, sequence: number): Promise<{ sequence: number }> {
    const { group } = await this.readGroup(user, tabId, conversationId)
    const target = Math.min(sequence - 1, group.data!.lastMessageSequence)
    return { sequence: await lowerReadMark(this.db, { tabId, personId: user.sub, conversationId, sequence: target, now: this.now() }) }
  }

  /** Moves the person's mark of thread `threadId` in a conversation they can read forward, never past the conversation's
   *  newest message (readMarks.ts), which the reader sees already: a hidden reply's sequence never shows in the answer.
   *  Checked as a page of messages is (store.ts messages): the Swarm read with that conversation alone, then the root by its
   *  id, a root the person may read (not an agent-only notice, not a delivered copy) that roots its own thread. Every miss,
   *  an unreadable conversation or project included, is the same refusal. Only a person reading as themselves has marks. */
  async markThreadRead(user: AuthUser, tabId: string, conversationId: string, threadId: string, sequence: number): Promise<{ sequence: number }> {
    const newest = await this.readableThread(user, tabId, conversationId, threadId)
    return { sequence: await writeThreadMark(this.db, { tabId, personId: user.sub, conversationId, threadId, sequence: Math.min(sequence, newest), now: this.now() }) }
  }

  /** The newest message sequence of a conversation whose thread `threadId` the person reads (markThreadRead's checks). */
  private async readableThread(user: AuthUser, tabId: string, conversationId: string, threadId: string): Promise<number> {
    const unavailable = () => fail('NOT_FOUND', 'This conversation is unavailable.', 404)
    const newest = (await this.readableChat(user, tabId, conversationId)).conversation.lastMessageSequence
    const [found] = await readBy(this.db, 'SuperTabMessage', 'id', [{ $match: { _id: threadId, tabId, conversationId } },
      { $project: { source: 1, recipientIds: 1, thread: 1 } }])
    const root = found && { id: found._id as string, source: found.source ?? null, recipientIds: (found.recipientIds as string[] | undefined) ?? [], thread: found.thread }
    if (!root || root.thread !== root.id || agentOnly(root.source, root.recipientIds) || (await deliveredCopies(this.db, tabId, [root])).size) unavailable()
    return newest
  }

  /** A person's own chat settings (an agent has none), every one or those moved since `since`. */
  private async settingsOf(tx: PrismaClient, tabId: string, actor: Actor, since?: number): Promise<Map<string, NotifyLevel>> {
    return actor.kind === 'person' ? readChatSettings(tx, tabId, actor.userId, since) : new Map()
  }

  /** Stores the person's notification setting for a conversation they can read (chatSettings.ts), checked as a read mark is:
   *  every miss is the same refusal, and only a person reading as themselves has settings. */
  async setChatNotify(user: AuthUser, tabId: string, conversationId: string, notify: NotifyLevel): Promise<{ notify: NotifyLevel }> {
    await this.group(user, tabId, conversationId)
    return { notify: await writeChatSetting(this.db, { tabId, personId: user.sub, conversationId, notify, now: this.now() }) }
  }

  /** Conversation `conversationId` and the Swarm's state, for a person reading as themselves who reads it: every conversation
   *  they cannot read, or that does not exist, is the same refusal. The Swarm is read with that conversation alone. */
  private async readableChat(user: AuthUser, tabId: string, conversationId: string): Promise<{ state: SuperTabState; conversation: Conversation }> {
    const { state } = await this.store.readLoad(user, tabId, { groupIds: [conversationId] })
    const actor = await this.store.actor(this.db, user, state)
    try {
      return { state, conversation: readConversation(state, actor, conversationId) }
    } catch (error) {
      if (error instanceof SuperTabError && error.status === 404) fail('NOT_FOUND', 'This conversation is unavailable.', 404)
      throw error
    }
  }

  /** A person's own thread marks (an agent has none), every one or those moved since `since`. */
  private async threadMarksOf(tx: PrismaClient, tabId: string, actor: Actor, since?: number): Promise<Map<string, Map<string, number>>> {
    return actor.kind === 'person' ? readThreadMarks(tx, tabId, actor.userId, since) : new Map()
  }

  /** A person's own read marks (an agent has none), every one or those moved since `since`. */
  private async marksOf(tx: PrismaClient, tabId: string, actor: Actor, since?: number): Promise<ReadMarkRow[]> {
    return actor.kind === 'person' ? readMarkRows(tx, tabId, actor.userId, since) : []
  }

  /** One project's leaderboard for a week (leaderboard/stats.ts), for the people who read the project. It sums only the
   *  groups the reader may read, dormant ones of the kept weeks included, and never a private conversation. */
  async leaderboard(user: AuthUser, tabId: string, projectId: string, week?: number, period?: PeriodName, allProjects = false): Promise<Leaderboard> {
    const now = this.now(), start = readableWeek(week, now)
    const began = performance.now()
    const result = await this.read(user, tabId, async (tx, cached) => {
      const state = parts.reassemble(await readParts(tx, cached, tabId), { share: true })
      const actor = await this.store.actor(tx, user, state)
      readProject(state, actor, projectId)
      // Every project this reader reads, by the same check as the one asked for; what they may not read is never loaded.
      const readable = allProjects ? projectsOf(state).filter(p => canReadProject(state, actor, p)).map(p => p.id) : undefined
      const load = async () => {
        const dormant = await recentDormantGroups(tx, cached, tabId, readable ?? projectId, now - LEDGER_WEEKS * WEEK_MS)
        const groups = [...state.conversations.filter(g => !g.dormant), ...dormant].filter(g => !isLeads(g) && canReadGroup(state, actor, g))
        // Names change rarely and show on a board: read on the secondary (task #2970).
        const names = await profileNames(this.store.replica, state.people.map(p => p.id))
        const visible = visibleState(state, actor, now)
        // Count only agents this reader sees, keeping ownership before presentation redaction.
        const agentIds = new Set(visible.agents.map(a => a.id))
        const visibleAgents = state.agents.filter(a => agentIds.has(a.id))
        const machines = (visible.machines ?? [])
          .map(m => ({ ...m, lentDays: state.machines?.find(own => own.machineId === m.machineId)?.lentDays }))
        return leaderboard({ state, groups, machines, visibleAgents, projectId, week: start, now, period, allProjects: readable, names })
      }
      // Access is resolved afresh above, even when the aggregate is held. Include the current audience in the key.
      return allProjects && !period
        ? weeklyBoard(cached, tabId, JSON.stringify([actor, readable]), projectId, start, now, load)
        : load()
    })
    const elapsedMs = performance.now() - began
    if (allProjects && !period && elapsedMs > 100) logger.warn('[weekly-leaderboard] slow read', { elapsedMs: Math.round(elapsedMs) })
    return result
  }

  async list(user: AuthUser, after?: string): Promise<SwarmList> {
    // People at the owner's domain join Swarms with auto-join on by themselves, before the first page is read (autoJoin.ts).
    if (!after) await this.store.autoJoin(user)
    const rows = await memberSwarms(this.db, user.autonomousEnv, user.sub, { after, limit: 101 })
    // A Swarm still in one row is from before the parts: it is never served, and the wipe removes it (migration/wipeJob.ts).
    const page = rows.slice(0, 100).filter(r => r.format === 2)
    const ids = page.map(r => r.id)
    // Every head changed after the epoch: one read of each listed Swarm's head part.
    // Each Swarm's newest change through the read cache, at its stamp: a list every few seconds no longer recomputes it.
    const [heads, newest] = await Promise.all([transaction(this.db, tx => parts.loadChanged(tx, ids, new Date(0), ['head'])),
      this.store.view(ids).then(view => readLastChangedAts(this.db, view, ids))])
    return { tabs: page.map(row => {
      const head = heads.get(row.id)![0]!.data as { name: string; paused: boolean }
      // Only the reader's own Personal Swarm is marked (a round dial's Personal | Team picker); another person's is not theirs
      // to be told apart. Its id is derived from its owner and environment (deletion.ts), so no read is needed.
      const personal = row.ownerId === user.sub && isPersonalSwarm({ id: row.id, environment: user.autonomousEnv, ownerId: row.ownerId })
      return { id: row.id, name: head.name, ownerId: row.ownerId, paused: head.paused, lastChangedAt: newest.get(row.id) ?? null,
        ...personal ? { personal: true as const } : {} }
    }), next: rows.length > 100 ? rows[99]!.id : null }
  }

  /** Runs a read, outside any transaction: its parts come through the read cache at the stamps `body` is given (cache.ts),
   *  and only the read of the base parts on a miss is a transaction (cachedReads.ts). */
  private async read<T>(user: AuthUser, tabId: string, body: (tx: PrismaClient, view: CacheView) => Promise<T>): Promise<T> {
    const row = await this.swarmRow(user, tabId)
    // A deleted Swarm reads as one that does not exist (deletion.ts), and so does one still in one row: it is from before the
    // parts, and the wipe removes it (migration/wipeJob.ts).
    if (!row || row.deletedAt || row.format !== 2) fail('NOT_FOUND', 'This Super Tab is unavailable.', 404)
    return body(this.db, await this.store.view([tabId]))
  }

  /** The row's format and deletion only, never its other fields. */
  private swarmRow(user: AuthUser, tabId: string): Promise<SwarmRow | null> {
    const now = this.now(), key = JSON.stringify([user.autonomousEnv, tabId])
    const kept = this.swarmRows.get(key)
    if (kept && now >= kept.at && now - kept.at < SWARM_ROW_READS_MS) return kept.read
    if (kept) this.swarmRows.delete(key)
    // Entries are inserted in time order, so an expired prefix is enough to clear old Swarms on each request.
    for (const [old, entry] of this.swarmRows) {
      if (now >= entry.at && now - entry.at < SWARM_ROW_READS_MS) break
      this.swarmRows.delete(old)
    }
    const entry: SwarmRowRead = { at: now, read: this.db.superTab.findFirst({ where: { id: tabId, autonomousEnv: user.autonomousEnv },
      select: { format: true, deletedAt: true } }) }
    this.swarmRows.set(key, entry)
    while (this.swarmRows.size > MAX_SWARM_ROW_READS) this.swarmRows.delete(this.swarmRows.keys().next().value!)
    // A missing row or a failed read is not held: a newly created Swarm and a recovered database answer on the next request.
    entry.read.then(row => { if (!row && this.swarmRows.get(key) === entry) this.swarmRows.delete(key) }, () => {
      if (this.swarmRows.get(key) === entry) this.swarmRows.delete(key)
    })
    return entry.read
  }

  private async load(tx: PrismaClient, cached: CacheView, user: AuthUser, tabId: string, asAgentId: string | undefined, t0: number, opts: LoadOptions,
    loader: Loader = (view, id, named) => readParts(tx, view, id, named)): Promise<Read> {
    const loaded = await loader(cached, tabId, opts)
    const state = parts.reassemble(loaded, { share: true })
    const actor = await this.store.actor(tx, user, state, asAgentId)
    const [machineVersions, newest] = await Promise.all([this.machineLookups(state), readLastChangedAt(tx, cached, tabId)])
    const view = readerView(loaded, actor, t0, { machineVersions }, state)
    // People count a chat unread by its newest main row; agents keep no read marks.
    if (actor.kind === 'person') view.parts.groups = await this.servedTops.served(tabId, state, view.parts.groups)
    return { parts: loaded, actor, lastChangedAt: newest, view }
  }

  /** The CLI version each of the Swarm's machines' daemons last connected with (store.ts): the
   *  same answer for every reader, whose view hides what it may not see, so one lookup serves every read of the Swarm for
   *  MACHINE_READS_MS. A start's dispatch still looks up afresh (store.ts executeOnce). Outside any transaction, as every read is. */
  private machineLookups(state: SuperTabState): Promise<MachineReads> {
    if (!state.machines?.length) return Promise.resolve({})
    const now = this.now()
    const key = JSON.stringify([state.id, state.environment, state.machines.map(m => m.machineId).sort()])
    const kept = this.machineReads.get(key)
    if (kept && now >= kept.at && now - kept.at < MACHINE_READS_MS) return kept.read
    for (const [old, entry] of this.machineReads) {
      if (now >= entry.at && now - entry.at < MACHINE_READS_MS) break
      this.machineReads.delete(old)
    }
    const entry = { at: now, read: this.store.machineVersions(this.db, state) }
    this.machineReads.delete(key)
    this.machineReads.set(key, entry)
    // A failed lookup is never reused.
    entry.read.catch(() => { if (this.machineReads.get(key) === entry) this.machineReads.delete(key) })
    return entry.read
  }
}
