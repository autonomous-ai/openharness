/**
 * The Swarms a Harness Pro shows as cards on Home: for each Swarm (Super Tab) this account is in, one Lead per project with
 * what it is doing now, plus the last thing a Lead said, for the Pro's recap. Read as the person (never as an agent) from
 * the same backend routes the desktop uses, every 5 s while a capable Pro is attached (`want`), and a tab's detail is read
 * only when its `lastChangedAt` moved, by what changed since the last read (superTabs/swarmReads.ts). The service hands the
 * result to the core whole (`onCards`); the core owns the wire.
 *
 * Status of a project's Lead, most pressing first: `ask` (an assignment of the project needs a person, `needs_human`),
 * `stuck` (`blocked`), `work` (an agent of the project, the Lead or a worker, runs here and is in a turn, as the app marks each
 * agent working by its own live turn, `since` from the earliest of those turns; or an assignment works or is in review, all there is for agents on
 * other machines), else `done`.
 * A paused Swarm keeps its card and every Lead reads `done`.
 *
 * For the round dial (design 2026-10-28-round-dial-swarm-chat) every Lead also carries the chat on its project's face (`chat`):
 * the Lead conversation, or the project's Chat with PM or group the window has open (`want`'s focus); and the newest message
 * the Lead wrote in its Lead conversation or Chat with PM since the baseline (`notice`), the dial's one alert. `state` keeps
 * its meaning for the Pro and older dials, which never read either.
 */
import { randomUUID } from 'node:crypto'
import type { CoreApi } from '../core/api.js'
import { backend, SuperTabHostError } from './host.js'
import { identifier, object } from './wire.js'
import { SwarmReads, type SwarmRead } from './swarmReads.js'

type Json = Record<string, unknown>
/** The cards' shapes are the core's contract with the Swarm (core/api.ts), which the core declares and the Swarm imports. */
import type { CardFocus, ChatKind, LeadNotice, LeadRecap, LeadState, SwarmCard, SwarmChat, SwarmLead } from '../core/api.js'
export type { CardFocus, LeadNotice, LeadRecap, LeadState, SwarmCard, SwarmChat, SwarmLead } from '../core/api.js'

const MAX_CARDS = 16, MAX_LEADS = 12, NAME_BYTES = 48, RECAP_BYTES = 1500, MAX_LIST_PAGES = 10, MAX_RECAPS_IN_FLIGHT = 2
/** The Pro keeps an id in 48 bytes with its NUL: 47 characters at most reach it. */
const ID_BYTES = 47
export const cardId = (v: unknown): v is string => identifier(v) && v.length <= ID_BYTES
const ORDER: Record<LeadState, number> = { ask: 0, stuck: 1, work: 2, done: 3 }

/** Cut on a character, never inside one: the Pro refuses a string it cannot read as UTF-8. */
function cut(text: string, bytes: number): string {
  let out = '', used = 0
  for (const char of text) {
    used += Buffer.byteLength(char)
    if (used > bytes) break
    out += char
  }
  return out
}
const list = (v: unknown): Json[] => Array.isArray(v) ? v.map(object) : []
const projectKey = (project: Json): string => String(project.id ?? 'lead')
const inProject = (conversation: Json, projectId: string): boolean => (conversation.projectId ?? 'lead') === projectId
/** The reader's Chat with PM: the backend sends a private conversation's `audience` only to the people in it (`visibleState`). */
const isPmChat = (conversation: Json): boolean => !!conversation.audience && typeof conversation.audience === 'object'
const sequenceOf = (conversation: Json): number => typeof conversation.lastMessageSequence === 'number' ? conversation.lastMessageSequence : 0

/** The conversation on a project's face and its kind: the one the window has open when it is a live conversation of this
 *  project, else the project's Lead conversation; null when that one's id is not one a dial can hold. An archived group is
 *  over: the face stays on the Lead (Ruling on the plan, 2026-10-28). */
function faceOf(conversations: Json[], projectId: string, lead: Json, focus?: string): { conversation: Json; kind: ChatKind } | null {
  const open = focus !== undefined && focus !== lead.id
    ? conversations.find(c => c.id === focus && inProject(c, projectId) && c.archived !== true && cardId(c.id)) : undefined
  if (open) return { conversation: open, kind: isPmChat(open) ? 'pm' : 'group' }
  return cardId(lead.id) ? { conversation: lead, kind: 'lead' } : null
}
/** Whose messages are the chat's recap: the Lead's in its conversation and Chat with PM, the group's agents' in a group. */
function voicesOf(face: { conversation: Json; kind: ChatKind }, leadId: string): Set<string> {
  if (face.kind !== 'group') return new Set([leadId])
  return new Set(Array.isArray(face.conversation.agentIds) ? face.conversation.agentIds.filter((id): id is string => typeof id === 'string') : [])
}

/**
 * One Lead per project of the Swarm, most urgent first with ties in project order; the 12 most urgent are kept, and each
 * carries its project's index as `order` (gaps where a project has no Lead or was cut). `live` says whether this machine's core has a
 * harness and whether it is in a turn (null: not here); `me` is the signed-in person's id, so a Lead on someone else's
 * machine names that owner (people[] has an email, which is the name a Swarm shows a person by).
 */
export function leadsOf(state: Json, machineId: string, live: (harnessId: string) => { inTurn: boolean; since?: number } | null, me?: string, focus?: string): { count: number; leads: SwarmLead[] } {
  const agents = list(state.agents), conversations = list(state.conversations), people = list(state.people)
  // An old tab has no `projects`: its one project is the tab itself, `lead`, led by the conversation `lead`.
  const projects = Array.isArray(state.projects) ? list(state.projects) : [{ id: 'lead', name: state.name, leadConversationId: 'lead' }]
  const paused = state.paused === true
  // An agent's project as the app's roster reads it: its own, else the first group that has it or that it leads.
  const projectOf = (a: Json) => typeof a.projectId === 'string' ? a.projectId
    : conversations.find(c => (Array.isArray(c.agentIds) && c.agentIds.includes(a.id)) || c.leadId === a.id)?.projectId ?? 'lead'
  const turnHere = (a: Json) => a.machineId === machineId && typeof a.harnessId === 'string' && a.harnessId !== '' ? live(a.harnessId) : null
  const leads: SwarmLead[] = []
  for (const [order, project] of projects.entries()) {
    const lead = conversations.find(c => c.id === project.leadConversationId)
    const agent = lead && agents.find(a => a.id === lead.leadId)
    if (!agent) continue
    if (!cardId(agent.id) || !cardId(project.id ?? 'lead')) continue
    const harnessId = typeof agent.harnessId === 'string' ? agent.harnessId : ''
    const here = agent.machineId === machineId && harnessId ? live(harnessId) : null
    const waits = new Set(conversations.filter(c => (c.projectId ?? 'lead') === (project.id ?? 'lead') && c.archived !== true)
      .map(c => object(c.assignment).status))
    let state: LeadState = 'done', since: number | undefined
    if (!paused) {
      if (waits.has('needs_human')) state = 'ask'
      else if (waits.has('blocked')) state = 'stuck'
      else {
        // The project's clock is its earliest turn here (the most seconds in), the Lead's or a worker's.
        const turns = [here, ...agents.filter(a => a !== agent && projectOf(a) === (project.id ?? 'lead')).map(turnHere)].filter(t => t?.inTurn)
        if (turns.length) {
          state = 'work'
          const secs = turns.map(t => t!.since).filter((v): v is number => typeof v === 'number')
          if (secs.length) since = Math.max(...secs)
        } else if (waits.has('working') || waits.has('review')) state = 'work'
      }
    }
    const ownerId = agent.machineOwnerId
    const owner = me && typeof ownerId === 'string' && ownerId !== me ? people.find(p => p.id === ownerId) : undefined
    const face = faceOf(conversations, projectKey(project), lead, focus)
    let chat: SwarmChat | undefined
    if (face) {
      const { conversation, kind } = face
      // Only a group works on the dial, and only while its assignment works: Lead and PM chats never do (design decision 4).
      const working = kind === 'group' && object(conversation.assignment).status === 'working'
      const voices = voicesOf(face, String(agent.id))
      const turns = working ? agents.filter(a => voices.has(a.id as string)).map(turnHere).filter(t => t?.inTurn) : []
      const secs = turns.map(t => t!.since).filter((v): v is number => typeof v === 'number')
      chat = { kind, id: conversation.id as string, name: kind === 'lead' ? 'Lead' : kind === 'pm' ? 'PM' : cut(String(conversation.title ?? ''), NAME_BYTES), working,
        ...(secs.length ? { since: Math.max(...secs) } : {}) }
    }
    leads.push({
      id: String(agent.id), projectId: String(project.id ?? 'lead'), project: cut(String(project.name ?? ''), NAME_BYTES), engine: String(object(agent.configuration).engine ?? ''),
      owner: owner && typeof owner.email === 'string' ? cut(owner.email, NAME_BYTES) : '',
      local: here && cardId(harnessId) ? harnessId : '', state, order, ...(since !== undefined ? { since } : {}), ...(chat ? { chat } : {}),
    })
  }
  // Array.sort is stable: equal urgency keeps the project order.
  const ordered = leads.map((l, i) => ({ l, i })).sort((a, b) => ORDER[a.l.state] - ORDER[b.l.state] || a.i - b.i).map(x => x.l)
  return { count: ordered.length, leads: ordered.slice(0, MAX_LEADS) }
}

/** The newest row one of the chat's agents wrote: a person-visible message, not a system row (`source`), the person's or
 *  another agent's. `at` in seconds; `id` the message's, or '' when it has none. */
export function lastAgentMessage(messages: Json[], agentIds: ReadonlySet<string>): { text: string; at: number; id: string; sequence: number } | null {
  let best: { text: string; at: number; id: string; sequence: number } | null = null
  for (const item of messages) {
    const m = object(item)
    const author = object(m.author).id
    if (m.source != null || typeof author !== 'string' || !agentIds.has(author) || typeof m.text !== 'string') continue
    const sequence = typeof m.sequence === 'number' ? m.sequence : -1
    if (best && sequence <= best.sequence) continue
    const stamp = typeof m.createdAt === 'number' ? m.createdAt : Date.parse(String(m.createdAt))
    best = { text: m.text, at: Number.isFinite(stamp) ? Math.floor(stamp / 1000) : 0, id: typeof m.id === 'string' ? m.id : '', sequence }
  }
  return best
}

interface TabCache { lastChangedAt: number | null; state: Json }
interface Cached { sequence: number; recap: LeadRecap }
/** A Lead some Harness Pro has the recap of open, and the sessions (one per Pro) that have it open. With `chat` (a round dial
 *  that speaks `swarmChat`), the recap is the face chat's, and `chatId` the chat it was last told of. */
interface Opened { tabId: string; leadId: string; chat: boolean; chatId: string | null; sequence: number | null; sessions: Set<string> }
/** Where a recap is read, or talk is posted: a conversation, how far it has gone, and whose messages are its recap. */
interface Target { id: string; sequence: number; voices: Set<string>; chatId?: string }
const recapKey = (tabId: string, leadId: string, chatId?: string) => chatId === undefined ? `${tabId}:${leadId}` : `${tabId}:${leadId}:${chatId}`
const tabOf = (read: SwarmRead): TabCache => ({ lastChangedAt: read.lastChangedAt, state: read.state })

export class SwarmCards {
  onCards?: (cards: SwarmCard[]) => void
  onRecap?: (recap: LeadRecap) => void
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly log: (line: string) => void
  private timer: NodeJS.Timeout | undefined
  private busy = false
  private tabs = new Map<string, TabCache>()
  /** The tabs to show, in the list's order, with the name the list gave each, as the last poll read them. */
  private rows: Array<{ id: string; name: unknown }> = []
  private recaps = new Map<string, Cached>()
  /** When each local Lead's current turn began, so `since` counts on between polls. */
  private turns = new Map<string, number>()
  /** Whether a harness is here and in a turn, as the last poll read it; null before the first. */
  private live: ((harnessId: string) => { inTurn: boolean; since?: number } | null) | null = null
  private last: string | null = null
  /** When each shown Lead's clock started (ms, `${card}/${lead}`), as the list last sent said. */
  private lastStarts = new Map<string, number>()
  private me: string | undefined
  private include: string[] = []
  /** The conversation the window has open in a Swarm tab: that project's face follows it. */
  private focus: CardFocus | null = null
  private opened = new Map<string, Opened>()
  private openBy = new Map<string, string>()
  private recapsRunning = 0
  /** One push of open recaps at a time: a focus change and a poll that both see a new face push it once. */
  private pushing: Promise<void> = Promise.resolve()
  /** The alert baseline: per watched conversation (`${tab}:${conversation}`), the last sequence whose messages were seen. */
  private seen = new Map<string, number>()
  /** Each Lead's newest notice (`${tab}:${lead}`), carried on its card. */
  private notices = new Map<string, LeadNotice>()
  /** Watched conversations whose last read failed, so a run of failures is logged once. */
  private failed = new Set<string>()
  private readonly reads: SwarmReads

  constructor(private readonly core: CoreApi, private readonly machineId: string, options: { now?: () => number; intervalMs?: number; reads?: SwarmReads; log?: (line: string) => void } = {}) {
    this.now = options.now ?? Date.now
    this.intervalMs = options.intervalMs ?? 5000
    this.reads = options.reads ?? new SwarmReads(core)
    this.log = options.log ?? (line => console.log(line))
  }

  /** Poll while a capable Pro is attached; none otherwise (no request at all). `include`: the Swarms the desktop has tabs for,
   *  read first. `focus`: the conversation the window has open in a Swarm tab; a change rebuilds the cards at once from the
   *  last reads, with no request. */
  want(on: boolean, include: string[] = [], focus: CardFocus | null = null): void {
    if (!on) {
      if (this.timer) clearInterval(this.timer)
      this.timer = undefined
      this.opened.clear(); this.openBy.clear(); this.include = []; this.focus = null
      // A device that attaches again starts a fresh baseline: what was said while none was here never alerts.
      this.seen.clear(); this.notices.clear(); this.failed.clear()
      return
    }
    const wanted = include.filter(cardId).slice(0, MAX_CARDS)
    const moved = wanted.join(',') !== this.include.join(',')
    this.include = wanted
    const next = focus && cardId(focus.tabId) && cardId(focus.conversationId) ? { tabId: focus.tabId, conversationId: focus.conversationId } : null
    const refocused = `${next?.tabId}/${next?.conversationId}` !== `${this.focus?.tabId}/${this.focus?.conversationId}`
    this.focus = next
    if (this.timer) {
      if (refocused && this.live) { this.emit(); void this.pushOpen() }
      if (moved) void this.tick()
      return
    }
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    this.timer.unref?.()
    void this.tick()
  }

  /** The recap on a Pro's screen (leadId null: closed), per Pro `session`: a change in that Lead's conversation is pushed once.
   *  With `chat`, the face chat's: a change in it, or another chat on the face, is pushed once. */
  open(session: string, tabId: string, leadId: string | null, chat = false): void {
    const before = this.openBy.get(session)
    if (before) {
      const held = this.opened.get(before)
      held?.sessions.delete(session)
      if (held && !held.sessions.size) this.opened.delete(before)
      this.openBy.delete(session)
    }
    if (!leadId || !cardId(session) || !cardId(tabId) || !cardId(leadId)) return
    const key = `${recapKey(tabId, leadId)}${chat ? ':chat' : ''}`
    let entry = this.opened.get(key)
    if (!entry) {
      // From what the Pro was shown when there is a recap read, else from the first read of the tab: the next change is pushed.
      const target = this.target(tabId, leadId, chat)
      entry = { tabId, leadId, chat, chatId: target?.chatId ?? null,
        sequence: target ? this.recaps.get(recapKey(tabId, leadId, target.chatId))?.sequence ?? target.sequence : null, sessions: new Set() }
      this.opened.set(key, entry)
    }
    entry.sessions.add(session)
    this.openBy.set(session, key)
  }

  /** Whether a Swarm read last lists this harness on that machine as one of its workers (a Builder or Reviewer): a member
   *  that leads no conversation and that the Swarm started, by its start record (the proof superTabs/host.ts closes workers
   *  by). A session the person opened by hand and added is theirs, as on this computer (services/devices.ts). A Swarm
   *  Reviewer on another computer failing every turn took over the round dial (2026-10-28), so the devices ask before they
   *  show a card's failure. Nothing is read for it: before the first poll, nobody is one. */
  worker(machineId: string, harnessId: string): boolean {
    return [...this.tabs.values()].some(({ state }) => {
      const member = list(state.agents).find(a => a.machineId === machineId && a.harnessId === harnessId)
      return !!member && !list(state.conversations).some(c => c.leadId === member.id)
        && list(state.starts).some(s => s.harnessId === harnessId && object(s.request).machineId === machineId && !s.error
          && s.creationId === `super-${String(s.id)}`)
    })
  }

  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try { await this.poll() } catch { /* the last cards stay: a dropped network says nothing about the Swarms */ } finally { this.busy = false }
  }

  /** The Swarms to show: those the desktop has tabs for first, then the list in its order, 16 in all. Paging stops once both are met. */
  private async listTabs(): Promise<Json[]> {
    const rows: Json[] = []
    let after = ''
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const data = object(await backend(this.core, 'GET', `/api/super-tabs/list${after ? `?after=${encodeURIComponent(after)}` : ''}`))
      rows.push(...list(data.tabs).filter(r => cardId(r.id)))
      if (!identifier(data.next)) break
      if (rows.length >= MAX_CARDS && this.include.every(id => rows.some(r => r.id === id))) break
      after = data.next
    }
    const first = this.include.map(id => rows.find(r => r.id === id)).filter((r): r is Json => !!r)
    return [...first, ...rows.filter(r => !first.includes(r))].slice(0, MAX_CARDS)
  }

  private async poll(): Promise<void> {
    const rows = await this.listTabs()
    const known = new Map<string, TabCache>()
    await Promise.all(rows.map(async row => {
      const id = row.id as string, held = this.tabs.get(id)
      // A row without a numeric change time cannot say it is unchanged: that tab is always read again.
      if (held && typeof row.lastChangedAt === 'number' && held.lastChangedAt === row.lastChangedAt) { known.set(id, held); return }
      try { known.set(id, tabOf(await this.reads.read(id))) } catch (error) {
        // Lost access drops only this card; any other failure keeps what was read before.
        const status = error instanceof SuperTabHostError ? error.status : 0
        if (held && status !== 401 && status !== 403) known.set(id, held)
      }
    }))
    this.tabs = known
    this.rows = rows.map(row => ({ id: row.id as string, name: row.name }))
    const me = (await this.core.account.identity().catch(() => null))?.accountId
    // Another person signed in: nothing of the last account's is kept, and the list is said again whatever it is.
    if (this.me !== undefined && me !== this.me) { this.last = null; this.recaps.clear(); this.seen.clear(); this.notices.clear(); this.failed.clear() }
    this.me = me ?? this.me
    const turns = await this.turnsHere()
    this.live = (harnessId: string) => this.core.agents.byAgent(harnessId) ? turns.get(harnessId) ?? { inTurn: false } : null
    await this.watchNotices()
    this.emit()
    this.prune()
    await this.pushOpen()
  }

  /** The cards from the last reads, said when they changed. */
  private emit(): void {
    const live = this.live ?? (() => null)
    const cards: SwarmCard[] = []
    for (const row of this.rows) {
      const tab = this.tabs.get(row.id)
      if (!tab) continue
      const focus = this.focus?.tabId === row.id ? this.focus.conversationId : undefined
      const { count, leads } = leadsOf(tab.state, this.machineId, live, this.me, focus)
      const noticed = leads.map(lead => {
        const notice = this.notices.get(recapKey(row.id, lead.id))
        return notice ? { ...lead, notice } : lead
      })
      cards.push({ id: row.id, name: cut(String(tab.state.name ?? row.name ?? ''), NAME_BYTES), count, leads: noticed })
    }
    // `since` moves every poll while a turn runs and the Pro counts on by itself, so it alone never re-sends the list.
    // Nor does a clock that keeps its turn; one whose turn changed (the Lead's ended, a worker's goes on) does. The start is
    // compared within 2 s: `since` is whole seconds, read at a poll's own moment.
    const signature = JSON.stringify(cards, (key, value) => key === 'since' ? value !== undefined : value)
    const now = this.now(), starts = new Map<string, number>()
    for (const card of cards) for (const lead of card.leads) if (lead.since !== undefined) starts.set(`${card.id}/${lead.id}`, now - lead.since * 1000)
    const moved = [...starts].some(([key, at]) => Math.abs(at - (this.lastStarts.get(key) ?? at)) > 2000)
    if (signature !== this.last || moved) { this.last = signature; this.lastStarts = starts; this.onCards?.(cards) }
  }

  /**
   * The dial's alerts (design 2026-10-28 §2): each project's Lead conversation and Chat with PM, by the `lastMessageSequence`
   * the tab reads already carry. A conversation first seen sets the baseline and is not read; one that moved past it has its
   * newest page read once, under the recaps' limit, and the newest message its Lead wrote after the baseline becomes the
   * Lead's notice. Two messages between two reads make one notice, for the newest. The baseline moves only after a read
   * that worked, so a failed one is tried again at the next poll. Groups are never watched.
   */
  private async watchNotices(): Promise<void> {
    const watched = new Set<string>()
    for (const [tabId, { state }] of this.tabs) {
      const conversations = list(state.conversations)
      for (const { project, lead, leadId } of leadProjects(state)) {
        const projectId = projectKey(project)
        const chats: Array<{ conversation: Json; chat: LeadNotice['chat'] }> = [{ conversation: lead, chat: 'lead' },
          ...conversations.filter(c => inProject(c, projectId) && isPmChat(c) && c.archived !== true).map(conversation => ({ conversation, chat: 'pm' as const }))]
        for (const { conversation, chat } of chats) {
          if (!cardId(conversation.id) || typeof conversation.lastMessageSequence !== 'number') continue
          const key = `${tabId}:${conversation.id}`, sequence = conversation.lastMessageSequence
          watched.add(key)
          const baseline = this.seen.get(key)
          if (baseline === undefined) { this.seen.set(key, sequence); continue }
          if (sequence <= baseline || this.recapsRunning >= MAX_RECAPS_IN_FLIGHT) continue
          this.recapsRunning++
          try {
            const page = object(await backend(this.core, 'GET', `/api/super-tabs/${tabId}/conversations/${conversation.id}/messages`))
            const after = list(page.messages).filter(m => typeof m.sequence === 'number' && m.sequence > baseline)
            const said = lastAgentMessage(after, new Set([leadId]))
            if (said && cardId(said.id)) {
              const notice: LeadNotice = { chat, chatId: conversation.id, id: said.id, text: cut(said.text, RECAP_BYTES), at: said.at }
              const held = this.notices.get(recapKey(tabId, leadId))
              if (!held || held.at <= notice.at) this.notices.set(recapKey(tabId, leadId), notice)
            }
            this.seen.set(key, sequence)
            this.failed.delete(key)
          } catch (error) {
            if (!this.failed.has(key)) {
              this.failed.add(key)
              this.log(`[super-tabs] a Lead's new message could not be read for the dial; tried again at the next poll: ${error instanceof Error ? error.message : String(error)}`)
            }
          } finally { this.recapsRunning-- }
        }
      }
    }
    // A Swarm or project that left the cards takes its baseline and notices with it.
    for (const key of [...this.seen.keys()]) if (!watched.has(key)) this.seen.delete(key)
    for (const key of [...this.failed]) if (!watched.has(key)) this.failed.delete(key)
    for (const [key, notice] of this.notices) if (!watched.has(`${key.slice(0, key.indexOf(':'))}:${notice.chatId}`)) this.notices.delete(key)
  }

  /** Which of the Leads that run here are in a turn, and since when (the core's windows' own measure of "working"). */
  private async turnsHere(): Promise<Map<string, { inTurn: boolean; since?: number }>> {
    const ids = new Set<string>()
    for (const { state } of this.tabs.values()) {
      for (const agent of list(state.agents)) if (agent.machineId === this.machineId && typeof agent.harnessId === 'string' && this.core.agents.byAgent(agent.harnessId)) ids.add(agent.harnessId)
    }
    const working = ids.size ? await this.core.agents.activity([...ids]).catch(() => ({} as Record<string, string>)) : {}
    const out = new Map<string, { inTurn: boolean; since?: number }>()
    const now = this.now()
    for (const id of ids) {
      if (working[id] !== 'working') { this.turns.delete(id); out.set(id, { inTurn: false }); continue }
      if (!this.turns.has(id)) {
        const elapsed = (await this.core.agents.activitySnapshot?.(id).catch(() => null))?.elapsedSeconds
        this.turns.set(id, now - (typeof elapsed === 'number' && elapsed > 0 ? elapsed * 1000 : 0))
      }
      // At least 1: the Pro reads 0 as no turn start and shows no clock.
      out.set(id, { inTurn: true, since: Math.max(1, Math.floor((now - this.turns.get(id)!) / 1000)) })
    }
    for (const id of [...this.turns.keys()]) if (!ids.has(id)) this.turns.delete(id)
    return out
  }

  /** Where the Lead's recap is read and its talk posted, from the tab as last read: its Lead conversation, or with `chat` the
   *  chat on its project's face (`chatId` set). */
  private target(tabId: string, leadId: string, chat: boolean): Target | null {
    const state = this.tabs.get(tabId)?.state
    if (!state) return null
    const found = leadProjects(state).find(p => p.leadId === leadId)
    if (!found || !identifier(found.lead.id)) return null
    if (!chat) return { id: found.lead.id, sequence: sequenceOf(found.lead), voices: new Set([leadId]) }
    const focus = this.focus?.tabId === tabId ? this.focus.conversationId : undefined
    const face = faceOf(list(state.conversations), projectKey(found.project), found.lead, focus)
    if (!face) return null
    const id = face.conversation.id as string
    return { id, sequence: sequenceOf(face.conversation), voices: voicesOf(face, leadId), chatId: id }
  }

  /** What the Lead last said: the newest page of its conversation, then one page back; `none` when neither holds a row of its own.
   *  With `chat`, what the chat on its face last heard from its agents, naming that chat. */
  async recap(tabId: string, leadId: string, chat = false): Promise<LeadRecap> {
    if (!cardId(tabId) || !cardId(leadId)) return { tabId, leadId, text: '', at: 0, none: true }
    let found = this.target(tabId, leadId, chat)
    if (!found) {
      if (this.recapsRunning >= MAX_RECAPS_IN_FLIGHT) throw new Error('too many recap reads at once')
      this.recapsRunning++
      try { this.tabs.set(tabId, tabOf(await this.reads.read(tabId))) } finally { this.recapsRunning-- }
      found = this.target(tabId, leadId, chat)
    }
    if (!found) return { tabId, leadId, text: '', at: 0, none: true }
    const named = found.chatId === undefined ? {} : { chatId: found.chatId }
    const key = recapKey(tabId, leadId, found.chatId), held = this.recaps.get(key)
    if (held && held.sequence === found.sequence) return held.recap
    // At most two backend reads of recaps run at once: a Pro that asks in a loop cannot flood the backend.
    if (this.recapsRunning >= MAX_RECAPS_IN_FLIGHT) throw new Error('too many recap reads at once')
    this.recapsRunning++
    try {
      const path = `/api/super-tabs/${tabId}/conversations/${found.id}/messages`
      const newest = object(await backend(this.core, 'GET', path))
      let said = lastAgentMessage(list(newest.messages), found.voices)
      // The page before, from the page's own (sequence, id) cursor: a page edge inside equal sequences skips nothing (design 4.6).
      const before = object(newest.next)
      if (!said && typeof before.sequence === 'number' && identifier(before.id)) {
        said = lastAgentMessage(list(object(await backend(this.core, 'GET', `${path}?before=${before.sequence}&beforeId=${before.id}`)).messages), found.voices)
      }
      const recap: LeadRecap = said ? { tabId, leadId, text: cut(said.text, RECAP_BYTES), at: said.at, none: false, ...named } : { tabId, leadId, text: '', at: 0, none: true, ...named }
      this.recaps.set(key, { sequence: found.sequence, recap })
      return recap
    } finally { this.recapsRunning-- }
  }

  /** Words spoken on a Pro to a Lead that runs here (its harness): posted as the person in that Lead's conversation, as typed in
   *  the Swarm chat; with `chat`, in the chat on its face. False when that harness leads no project in the Swarms as last read,
   *  so the caller sends the turn as before. */
  async say(harnessId: string, text: string, chat = false): Promise<boolean> {
    for (const [tabId, { state }] of this.tabs) {
      const agent = list(state.agents).find(a => a.machineId === this.machineId && a.harnessId === harnessId)
      const found = agent && cardId(agent.id) ? this.target(tabId, agent.id, chat) : null
      if (!found) continue
      await backend(this.core, 'POST', `/api/super-tabs/${tabId}/commands`, { operationId: `pro-voice-${randomUUID()}`,
        command: { type: 'message.send', conversationId: found.id, text, replyTo: null, recipientIds: [] } })
      return true
    }
    return false
  }

  /** Remembered recaps are kept only for Leads that are still in a tab, and a chat's only while it is on the face. */
  private prune(): void {
    for (const [key, held] of this.recaps) {
      const { tabId, leadId, chatId } = held.recap
      const now = this.target(tabId, leadId, chatId !== undefined)
      if (!now || now.chatId !== chatId) this.recaps.delete(key)
    }
  }

  /** Each open Lead that moved on since its Pro last got the recap, or whose face shows another chat: the new one is sent once.
   *  A failed read is tried again next tick. */
  private pushOpen(): Promise<void> {
    const run = this.pushing.then(() => this.pushOpenNow())
    this.pushing = run.catch(() => {})
    return run
  }
  private async pushOpenNow(): Promise<void> {
    for (const open of [...this.opened.values()]) {
      const target = this.target(open.tabId, open.leadId, open.chat)
      if (!target) continue
      if (open.sequence === null) { open.sequence = target.sequence; open.chatId = target.chatId ?? null; continue }
      if (open.sequence === target.sequence && open.chatId === (target.chatId ?? null)) continue
      const recap = await this.recap(open.tabId, open.leadId, open.chat).catch(() => null)
      if (!recap) continue
      open.sequence = target.sequence
      open.chatId = target.chatId ?? null
      this.onRecap?.(recap)
    }
  }
}

/** Each project of a tab whose Lead conversation names its Lead: the project, that conversation and the Lead agent's id. */
function leadProjects(state: Json): Array<{ project: Json; lead: Json; leadId: string }> {
  const conversations = list(state.conversations)
  const projects = Array.isArray(state.projects) ? list(state.projects) : [{ id: 'lead', leadConversationId: 'lead' }]
  const out: Array<{ project: Json; lead: Json; leadId: string }> = []
  for (const project of projects) {
    const lead = conversations.find(c => c.id === project.leadConversationId)
    if (lead && typeof lead.leadId === 'string') out.push({ project, lead, leadId: lead.leadId })
  }
  return out
}
