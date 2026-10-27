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
 */
import { randomUUID } from 'node:crypto'
import type { CoreApi } from '../core/api.js'
import { backend, SuperTabHostError } from './host.js'
import { identifier, object } from './wire.js'
import { SwarmReads, type SwarmRead } from './swarmReads.js'

type Json = Record<string, unknown>
export type LeadState = 'ask' | 'stuck' | 'work' | 'done'
/** `order`: the project's index in the Swarm (the app's order), so a dial can show the Leads as the app does whatever their urgency. */
export interface SwarmLead { id: string; projectId: string; project: string; engine: string; owner: string; local: string; state: LeadState; order: number; since?: number }
/** `needsYou`: what in this Swarm waits on the person reading it (their open decisions), absent when nothing does. A count only:
 *  what was asked is read in the app, never on a device someone else may be looking at. */
export interface SwarmCard { id: string; name: string; count: number; leads: SwarmLead[]; needsYou?: number }
export interface LeadRecap { tabId: string; leadId: string; text: string; at: number; none: boolean }

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

/**
 * One Lead per project of the Swarm, most urgent first with ties in project order; the 12 most urgent are kept, and each
 * carries its project's index as `order` (gaps where a project has no Lead or was cut). `live` says whether this machine's core has a
 * harness and whether it is in a turn (null: not here); `me` is the signed-in person's id, so a Lead on someone else's
 * machine names that owner (people[] has an email, which is the name a Swarm shows a person by).
 */
export function leadsOf(state: Json, machineId: string, live: (harnessId: string) => { inTurn: boolean; since?: number } | null, me?: string): { count: number; leads: SwarmLead[] } {
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
    leads.push({
      id: String(agent.id), projectId: String(project.id ?? 'lead'), project: cut(String(project.name ?? ''), NAME_BYTES), engine: String(object(agent.configuration).engine ?? ''),
      owner: owner && typeof owner.email === 'string' ? cut(owner.email, NAME_BYTES) : '',
      local: here && cardId(harnessId) ? harnessId : '', state, order, ...(since !== undefined ? { since } : {}),
    })
  }
  // Array.sort is stable: equal urgency keeps the project order.
  const ordered = leads.map((l, i) => ({ l, i })).sort((a, b) => ORDER[a.l.state] - ORDER[b.l.state] || a.i - b.i).map(x => x.l)
  return { count: ordered.length, leads: ordered.slice(0, MAX_LEADS) }
}

/** The newest row the Lead itself wrote: a person-visible message, not a system row (`source`) or someone else's. `at` in seconds. */
export function lastLeadMessage(messages: Json[], leadId: string): { text: string; at: number } | null {
  let best: { text: string; at: number; sequence: number } | null = null
  for (const item of messages) {
    const m = object(item)
    if (m.source != null || object(m.author).id !== leadId || typeof m.text !== 'string') continue
    const sequence = typeof m.sequence === 'number' ? m.sequence : -1
    if (best && sequence <= best.sequence) continue
    const stamp = typeof m.createdAt === 'number' ? m.createdAt : Date.parse(String(m.createdAt))
    best = { text: m.text, at: Number.isFinite(stamp) ? Math.floor(stamp / 1000) : 0, sequence }
  }
  return best && { text: best.text, at: best.at }
}

interface TabCache { lastChangedAt: number | null; state: Json }
interface Cached { sequence: number; recap: LeadRecap }
/** A Lead some Harness Pro has the recap of open, and the sessions (one per Pro) that have it open. */
interface Opened { tabId: string; leadId: string; sequence: number | null; sessions: Set<string> }
const tabOf = (read: SwarmRead): TabCache => ({ lastChangedAt: read.lastChangedAt, state: read.state })

export class SwarmCards {
  onCards?: (cards: SwarmCard[]) => void
  onRecap?: (recap: LeadRecap) => void
  private readonly now: () => number
  private readonly intervalMs: number
  private timer: NodeJS.Timeout | undefined
  private busy = false
  private tabs = new Map<string, TabCache>()
  private recaps = new Map<string, Cached>()
  /** When each local Lead's current turn began, so `since` counts on between polls. */
  private turns = new Map<string, number>()
  private last: string | null = null
  /** When each shown Lead's clock started (ms, `${card}/${lead}`), as the list last sent said. */
  private lastStarts = new Map<string, number>()
  private me: string | undefined
  private include: string[] = []
  private opened = new Map<string, Opened>()
  private openBy = new Map<string, string>()
  private recapsRunning = 0
  private readonly reads: SwarmReads

  constructor(private readonly core: CoreApi, private readonly machineId: string, options: { now?: () => number; intervalMs?: number; reads?: SwarmReads } = {}) {
    this.now = options.now ?? Date.now
    this.intervalMs = options.intervalMs ?? 5000
    this.reads = options.reads ?? new SwarmReads(core)
  }

  /** Poll while a capable Pro is attached; none otherwise (no request at all). `include`: the Swarms the desktop has tabs for, read first. */
  want(on: boolean, include: string[] = []): void {
    if (!on) {
      if (this.timer) clearInterval(this.timer)
      this.timer = undefined
      this.opened.clear(); this.openBy.clear(); this.include = []
      return
    }
    const wanted = include.filter(cardId).slice(0, MAX_CARDS)
    const moved = wanted.join(',') !== this.include.join(',')
    this.include = wanted
    if (this.timer) { if (moved) void this.tick(); return }
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    this.timer.unref?.()
    void this.tick()
  }

  /** The recap on a Pro's screen (leadId null: closed), per Pro `session`: a change in that Lead's conversation is pushed once. */
  open(session: string, tabId: string, leadId: string | null): void {
    const before = this.openBy.get(session)
    if (before) {
      const held = this.opened.get(before)
      held?.sessions.delete(session)
      if (held && !held.sessions.size) this.opened.delete(before)
      this.openBy.delete(session)
    }
    if (!leadId || !cardId(session) || !cardId(tabId) || !cardId(leadId)) return
    const key = `${tabId}:${leadId}`
    let entry = this.opened.get(key)
    if (!entry) {
      // From what the Pro was shown when there is a recap read, else from the first read of the tab: the next change is pushed.
      entry = { tabId, leadId, sequence: this.recaps.get(key)?.sequence ?? this.sequenceOf(tabId, leadId), sessions: new Set() }
      this.opened.set(key, entry)
    }
    entry.sessions.add(session)
    this.openBy.set(session, key)
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
    const me = (await this.core.account.identity().catch(() => null))?.accountId
    // Another person signed in: nothing of the last account's is kept, and the list is said again whatever it is.
    if (this.me !== undefined && me !== this.me) { this.last = null; this.recaps.clear() }
    this.me = me ?? this.me
    const turns = await this.turnsHere()
    const live = (harnessId: string) => this.core.agents.byAgent(harnessId) ? turns.get(harnessId) ?? { inTurn: false } : null
    const cards: SwarmCard[] = []
    for (const row of rows) {
      const tab = known.get(row.id as string)
      if (!tab) continue
      const { count, leads } = leadsOf(tab.state, this.machineId, live, me)
      const waiting = tab.state.decisionsWaiting
      const needsYou = typeof waiting === 'number' && Number.isSafeInteger(waiting) && waiting > 0 ? waiting : 0
      cards.push({ id: row.id as string, name: cut(String(tab.state.name ?? row.name ?? ''), NAME_BYTES), count, leads, ...(needsYou ? { needsYou } : {}) })
    }
    // `since` moves every poll while a turn runs and the Pro counts on by itself, so it alone never re-sends the list.
    // Nor does a clock that keeps its turn; one whose turn changed (the Lead's ended, a worker's goes on) does. The start is
    // compared within 2 s: `since` is whole seconds, read at a poll's own moment.
    const signature = JSON.stringify(cards, (key, value) => key === 'since' ? value !== undefined : value)
    const now = this.now(), starts = new Map<string, number>()
    for (const card of cards) for (const lead of card.leads) if (lead.since !== undefined) starts.set(`${card.id}/${lead.id}`, now - lead.since * 1000)
    const moved = [...starts].some(([key, at]) => Math.abs(at - (this.lastStarts.get(key) ?? at)) > 2000)
    if (signature !== this.last || moved) { this.last = signature; this.lastStarts = starts; this.onCards?.(cards) }
    this.prune()
    await this.pushOpen()
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

  /** The Lead's conversation and how far it has gone, from the tab as last read. */
  private leadConversation(tabId: string, leadId: string): { id: string; sequence: number } | null {
    const state = this.tabs.get(tabId)?.state
    if (!state) return null
    const conversations = list(state.conversations)
    const projects = Array.isArray(state.projects) ? list(state.projects) : [{ leadConversationId: 'lead' }]
    for (const project of projects) {
      const lead = conversations.find(c => c.id === project.leadConversationId)
      if (lead && lead.leadId === leadId && identifier(lead.id)) return { id: lead.id, sequence: typeof lead.lastMessageSequence === 'number' ? lead.lastMessageSequence : 0 }
    }
    return null
  }
  private sequenceOf(tabId: string, leadId: string): number | null { return this.leadConversation(tabId, leadId)?.sequence ?? null }

  /** What the Lead last said: the newest page of its conversation, then one page back; `none` when neither holds a row of its own. */
  async recap(tabId: string, leadId: string): Promise<LeadRecap> {
    if (!cardId(tabId) || !cardId(leadId)) return { tabId, leadId, text: '', at: 0, none: true }
    let found = this.leadConversation(tabId, leadId)
    if (!found) {
      if (this.recapsRunning >= MAX_RECAPS_IN_FLIGHT) throw new Error('too many recap reads at once')
      this.recapsRunning++
      try { this.tabs.set(tabId, tabOf(await this.reads.read(tabId))) } finally { this.recapsRunning-- }
      found = this.leadConversation(tabId, leadId)
    }
    if (!found) return { tabId, leadId, text: '', at: 0, none: true }
    const key = `${tabId}:${leadId}`, held = this.recaps.get(key)
    if (held && held.sequence === found.sequence) return held.recap
    // At most two backend reads of recaps run at once: a Pro that asks in a loop cannot flood the backend.
    if (this.recapsRunning >= MAX_RECAPS_IN_FLIGHT) throw new Error('too many recap reads at once')
    this.recapsRunning++
    try {
      const path = `/api/super-tabs/${tabId}/conversations/${found.id}/messages`
      const newest = object(await backend(this.core, 'GET', path))
      let said = lastLeadMessage(list(newest.messages), leadId)
      // The page before, from the page's own (sequence, id) cursor: a page edge inside equal sequences skips nothing (design 4.6).
      const before = object(newest.next)
      if (!said && typeof before.sequence === 'number' && identifier(before.id)) {
        said = lastLeadMessage(list(object(await backend(this.core, 'GET', `${path}?before=${before.sequence}&beforeId=${before.id}`)).messages), leadId)
      }
      const recap: LeadRecap = said ? { tabId, leadId, text: cut(said.text, RECAP_BYTES), at: said.at, none: false } : { tabId, leadId, text: '', at: 0, none: true }
      this.recaps.set(key, { sequence: found.sequence, recap })
      return recap
    } finally { this.recapsRunning-- }
  }

  /** Words spoken on a Pro to a Lead that runs here (its harness): posted as the person in that Lead's conversation, as typed in
   *  the Swarm chat. False when that harness leads no project in the Swarms as last read, so the caller sends the turn as before. */
  async say(harnessId: string, text: string): Promise<boolean> {
    for (const [tabId, { state }] of this.tabs) {
      const agent = list(state.agents).find(a => a.machineId === this.machineId && a.harnessId === harnessId)
      const found = agent && cardId(agent.id) ? this.leadConversation(tabId, agent.id) : null
      if (!found) continue
      await backend(this.core, 'POST', `/api/super-tabs/${tabId}/commands`, { operationId: `pro-voice-${randomUUID()}`,
        command: { type: 'message.send', conversationId: found.id, text, replyTo: null, recipientIds: [] } })
      return true
    }
    return false
  }

  /** Words spoken on a device to the Swarm conversation the window has open: posted as the person with the command typing uses, after a
   *  fresh read as the person says they may post there. The window's own reading only chose the target; access can change after it.
   *  `operationId` is the recording's, so a retried post of the same words is one message. Errors are shown on the device as they are. */
  async post(tabId: string, conversationId: string, text: string, operationId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const me = (await this.core.account.identity().catch(() => null))?.accountId
    const state = me ? await this.reads.read(tabId).then(read => read.state, () => null) : null
    if (!state) return { ok: false, error: 'Could not read the Swarm. Try again.' }
    const person = list(state.people).find(p => p.id === me)
    if (!person) return { ok: false, error: 'You are no longer in this Swarm.' }
    if (person.role === 'viewer') return { ok: false, error: 'You can only read this Swarm.' }
    const group = list(state.conversations).find(c => c.id === conversationId)
    if (!group) return { ok: false, error: 'That conversation is no longer there.' }
    if (group.archived === true) return { ok: false, error: 'That conversation is archived.' }
    // A private conversation (a Chat with PM) admits its audience alone; the read should not even show another person's, but a post
    // there would put one person's words in someone else's private chat, so it is checked here as well.
    const audience = group.audience === undefined || group.audience === null ? null : list(object(group.audience).people)
    if (audience && !audience.some(p => p.id === me)) return { ok: false, error: 'That conversation is not yours to post in.' }
    try {
      await backend(this.core, 'POST', `/api/super-tabs/${tabId}/commands`, { operationId: `device-voice-${operationId}`,
        command: { type: 'message.send', conversationId, text, replyTo: null, recipientIds: [] } })
      return { ok: true }
    } catch (error) {
      // A 4xx is the Swarm's answer: nothing was written. Anything else may have been, so the person looks before saying it again.
      return error instanceof SuperTabHostError && error.status >= 400 && error.status < 500
        ? { ok: false, error: 'The Swarm refused that message.' }
        : { ok: false, error: 'Could not confirm it was posted. Check the Swarm chat.' }
    }
  }

  /** Remembered recaps are kept only for Leads that are still in a tab. */
  private prune(): void {
    for (const [key, held] of this.recaps) if (!this.leadConversation(held.recap.tabId, held.recap.leadId)) this.recaps.delete(key)
  }

  /** Each open Lead that moved on since its Pro last got the recap: the new one is sent once. A failed read is tried again next tick. */
  private async pushOpen(): Promise<void> {
    for (const open of [...this.opened.values()]) {
      const sequence = this.sequenceOf(open.tabId, open.leadId)
      if (sequence === null) continue
      if (open.sequence === null) { open.sequence = sequence; continue }
      if (open.sequence === sequence) continue
      const recap = await this.recap(open.tabId, open.leadId).catch(() => null)
      if (!recap) continue
      open.sequence = sequence
      this.onRecap?.(recap)
    }
  }
}
