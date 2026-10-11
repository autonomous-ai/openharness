/**
 * Agent Messages (docs/design/2026-10-10-agent-messages.md): harnesses in a tab with Agent Messages on message
 * each other with `harness send`. This is the whole service, on the core's API, in the core's process or in its
 * own (services/messages.ts, services/messagesProcess.ts):
 * - `send`: from `harness send` in an agent's pane, over this machine's socket. The pane names the sender.
 * - `deliver`, `status`, `who`: from the owner's other machines, over the paired relay.
 * - `history`: the windows' log of a tab.
 * Deliveries to this machine's agents are the mailbox's (mailbox.ts); a message for another machine's agent is
 * handed to that machine's daemon, which owns its delivery and is asked what became of it.
 */
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import type { CoreApi, ServiceRequests, TurnDelivery } from '../core/api.js'
import { env } from '../config/env.js'
import type { RegisteredSession } from '../lib/registry.js'
import { MessageDirectory, type Member } from './directory.js'
import { PaneInbox } from './inbox.js'
import { Mailbox, type MailboxAgent } from './mailbox.js'
import { LIMITS, MessageError, engineName, messageId, note, parseMessage, rendered, type DeliveryStatus, type Message, type Recipient, type Teammate } from './model.js'
import { messagesRpc, type Rpc } from './rpc.js'
import { Ledger, ledgerPath, parseStarted } from '../agentClient/ledger.js'
import { MessageStore, type LocalDelivery } from './store.js'

export interface MessagesOptions {
  /** Where its history and waiting deliveries are kept; an isolated fixture's own. */
  stateDir?: string
  /** The pane inboxes the messages hook reads (env.HARNESS_AGENT_MESSAGES_DIR); an isolated fixture's own. */
  inboxRoot?: string
  rpc?: Rpc
  /** The local socket's folder (`ADAPTER_DATA_DIR`) the other machines are reached through. */
  dataDir?: string
  /** Who started which harness (agentClient/ledger.ts); an isolated fixture's own. */
  ledgerFile?: string
  /** Something that decides whether a typed delivery may be written changed: the process tells the core. */
  changed?: () => void
  now?: () => number
}

export interface AgentMessages {
  requests: ServiceRequests
  /** Whether the core may write a typed delivery now: the mailbox's word, in line. */
  canWrite(deliveryId: string): boolean
  /** The service reached a core again, perhaps a new one: typed attempts in flight go back to the hook. */
  reconnected?(): void
  start(): void
  stop(): void
}

/** How often the service looks at its notes, its outbox and other machines' deliveries. */
export const TICK_MS = 5_000
/** How often a message waiting on another machine is asked about. */
export const REMOTE_STATUS_MS = 15_000
/** How long another machine's names for its agents are kept. */
export const WHO_MS = 60_000
/** How old an inbox file nothing here waits on must be before a start sweeps it away. */
export const SWEEP_AFTER_MS = 10 * 60_000

const PANE = /^%\d{1,9}$/
const key = (m: Member): string => `${m.machineId}/${m.agentId}`
const same = (a: Member, b: Member): boolean => a.machineId === b.machineId && a.agentId === b.agentId
/** Where a message between a harness and one it started is kept: they need share no tab. */
export const STARTED_TAB = { id: 'started', name: 'started' } as const

export function startAgentMessages(core: CoreApi, options: MessagesOptions = {}): AgentMessages {
  const now = options.now ?? Date.now
  const rpc = options.rpc ?? messagesRpc
  const self = (): string => core.daemon.machineId()
  const at = (machineId: string) => ({ port: core.daemon.port, machineId, dataDir: options.dataDir ?? core.dataDir })
  const store = new MessageStore(options.stateDir ?? join(core.dataDir, 'agent-messages'))
  const lineage = new Ledger(options.ledgerFile ?? ledgerPath(core.dataDir))
  /**
   * The harnesses [me] may message without a tab: the one that started it and those it started
   * (docs/design/2026-10-11-agent-client.md). This machine's only: another machine checks a delivery against its
   * own directory, and has no record of who started what here.
   */
  const linked = (me: Member): Member[] => (me.machineId === self() ? lineage.links(me).filter((m) => m.machineId === self()) : [])
  const inbox = new PaneInbox(options.inboxRoot ?? env.HARNESS_AGENT_MESSAGES_DIR)
  /** Other machines' names for their agents, with when they were asked. */
  const who = new Map<string, { name: string; engine: string; project?: string; at: number }>()
  /** When each other machine was last asked for names, answering or not. */
  const asked = new Map<string, number>()
  /** When each sender sent, for the rate limit. */
  const sent = new Map<string, number[]>()
  let timer: ReturnType<typeof setInterval> | null = null
  let lastRemoteStatus = -Infinity

  const directory = new MessageDirectory({
    read: async () => {
      const response = await core.account.backend('GET', '/api/agent-messages')
      if (response.status !== 200 || response.body.success !== true) throw new Error('directory unavailable')
      return response.body.data
    },
    changed: () => { mailbox.refuseAll(); notesPump(); options.changed?.() },
    now,
  })

  const live = (): RegisteredSession[] => core.agents.live().filter((s) => s.engine !== ('terminal' as string))
  const localAgent = (agentId: string): RegisteredSession | undefined => live().find((s) => s.agentId === agentId)
  const machineName = (machineId: string): string => directory.machineName(machineId) ?? (machineId === self() ? hostname().replace(/\.local$/, '') : machineId.slice(0, 8))

  const mailbox: Mailbox = new Mailbox({
    store, inbox, now,
    agent: (agentId): MailboxAgent | null => {
      const session = localAgent(agentId)
      if (!session) return null
      // The hook delivers only to this conversation: a Codex sub-agent runs its hooks from its parent's pane, and
      // a pane number tmux gives out again is another's. A Claude Code sub-agent says so itself (`agent_id`).
      return { pane: session.tmuxPane, session: session.sessionId ?? '', available: session.active && core.agents.terminalAvailable(agentId) }
    },
    deliver: (agentId, text, deliveryId) => { core.turns.deliver(agentId, text, deliveryId); options.changed?.() },
    refused: (delivery) => refusal(delivery),
    ready: () => directory.current() !== null,
    text: (delivery, message) => {
      const roster = rosterOf(delivery.agentId)
      return roster && store.state.noted[delivery.agentId] !== roster.signature ? `${roster.text}\n\n${rendered(message)}` : rendered(message)
    },
    changed: (status, delivery) => localChanged(status, delivery),
    writable: () => options.changed?.(),
  })

  /** Why a local delivery can no longer be made, or null. Nothing is refused before the directory is read. */
  function refusal(delivery: LocalDelivery): string | null {
    const entry = store.entry(delivery.messageId)
    if (!entry) return 'the message is no longer kept'
    if (!directory.current()) return null
    const recipient = { machineId: self(), agentId: delivery.agentId }
    if (directory.shared(entry.message.from, recipient)) return null
    if (linked(recipient).some((m) => same(m, entry.message.from))) return null
    const tab = directory.current()!.tabs.find((t) => t.id === entry.message.tabId)
    return tab && !tab.enabled ? 'Agent Messages were turned off in this tab' : 'it is no longer in a tab with the sender'
  }

  function localChanged(status: DeliveryStatus, delivery: LocalDelivery): void {
    const full = { ...status, machineId: self() }
    if (status.state === 'delivered') {
      const roster = rosterOf(delivery.agentId)
      // The note rode with this message: the agent has it.
      if (roster) { store.state.noted[delivery.agentId] = roster.signature; withdrawNote(delivery.agentId) }
    }
    if (store.status(full)) tellWindows(full.messageId)
    options.changed?.()
  }

  function tellWindows(id: string): void {
    const entry = store.entry(id)
    if (!entry) return
    core.clients.windows({ type: 'messages_changed', payload: {
      tabId: entry.message.tabId, messageId: id, at: entry.message.at,
      from: { machineId: entry.message.from.machineId, agentId: entry.message.from.agentId },
      to: entry.message.to.map((r) => {
        const status = entry.statuses.find((s) => s.machineId === r.machineId && s.agentId === r.agentId)
        return { machineId: r.machineId, agentId: r.agentId, state: status?.state ?? 'queued' }
      }),
    } })
  }

  // ── names and the roster note ────────────────────────────────────────────────────────────────────

  /** A teammate as the note and the roster show them: from this machine's registry, or another machine's word. */
  function teammate(member: Member): Teammate & { member: Member; known: boolean } {
    if (member.machineId === self()) {
      const session = localAgent(member.agentId)
      return { member, known: !!session, name: session ? core.agents.displayName(session) || member.agentId.slice(0, 8) : member.agentId.slice(0, 8),
        engine: session?.engine ?? 'agent', machine: machineName(member.machineId), ...(session?.cwd ? { where: basename(session.cwd) } : {}) }
    }
    const known = who.get(key(member))
    return { member, known: !!known, name: known?.name || member.agentId.slice(0, 8), engine: known?.engine ?? 'agent', machine: machineName(member.machineId),
      ...(known?.project ? { where: known.project } : {}) }
  }

  /**
   * Ask other machines for their agents' names, those not known or too old; a machine asked lately, answering or
   * not, is not asked again yet. The notes are looked at again only when a name changed: looked at on every
   * answer, a teammate no machine can name (a stopped harness here) asked again at once, without end.
   */
  async function learnNames(members: Member[], wait: boolean): Promise<void> {
    const byMachine = new Map<string, string[]>()
    for (const m of members) {
      if (m.machineId === self()) continue
      const known = who.get(key(m))
      if (known && now() - known.at < WHO_MS) continue
      if (now() - (asked.get(m.machineId) ?? -Infinity) < WHO_MS && !wait) continue
      byMachine.set(m.machineId, [...(byMachine.get(m.machineId) ?? []), m.agentId])
    }
    if (!byMachine.size) return
    let learned = false
    const asks = [...byMachine].map(async ([machineId, agentIds]) => {
      asked.set(machineId, now())
      try {
        const answer = await rpc(at(machineId), { action: 'who', agentIds }, 8_000)
        for (const a of Array.isArray(answer.agents) ? answer.agents as Record<string, unknown>[] : []) {
          if (typeof a.agentId !== 'string' || typeof a.name !== 'string') continue
          const before = who.get(`${machineId}/${a.agentId}`)
          const next = { name: a.name, engine: typeof a.engine === 'string' ? a.engine : 'agent',
            ...(typeof a.project === 'string' ? { project: a.project } : {}), at: now() }
          if (!before || before.name !== next.name || before.engine !== next.engine || before.project !== next.project) learned = true
          who.set(`${machineId}/${a.agentId}`, next)
        }
      } catch { /* that machine is away: its agents keep the names they had */ }
    })
    const done = Promise.all(asks).then(() => { if (learned) notesPump() })
    if (wait) await done
  }

  /** The note a local agent should have read, or null when it is in no tab with Agent Messages on and a teammate. */
  function rosterOf(agentId: string): { text: string; signature: string } | null {
    const me = { machineId: self(), agentId }
    const peers = directory.peers(me)
    if (!peers.length) return null
    const tabs = directory.tabsOf(me).map((t) => t.name)
    const mates = peers.map(teammate)
    const text = note(tabs.join('", "'), mates)
    return { text, signature: createHash('sha256').update(text).digest('hex').slice(0, 12) }
  }

  /**
   * Another of the owner's machines started a harness here for one of its agents (`harness new @this-machine`): kept
   * in this machine's record too, so the new harness's depth and this machine's limits count it.
   */
  function started(payload: Record<string, unknown>): Record<string, unknown> {
    const row = parseStarted(JSON.stringify(payload.row ?? null))
    if (!row || row.child.machineId !== self() || row.by.machineId === self()) throw new MessageError('INVALID_RECORD', 'That is not a harness another machine started here.')
    if (!core.agents.live().some((s) => s.agentId === row.child.agentId)) throw new MessageError('UNKNOWN_HARNESS', 'No such harness on this machine.')
    lineage.append(row)
    return { recorded: true }
  }

  /** The harnesses an agent started, or the one that started it, as `harness send` alone lists them. */
  function linkedNote(links: Member[]): string {
    const mates = links.map(teammate)
    const width = Math.max(...mates.map((t) => t.name.length))
    return ['[Harness] The harness that started you, and those you started:',
      ...mates.map((t) => `  ${t.name.padEnd(width)}  ${[engineName(t.engine), t.machine, t.where].filter(Boolean).join(' · ')}`),
      'Message them: harness send <name> "…"'].join('\n')
  }

  function withdrawNote(agentId: string): void {
    const pending = store.state.notes[agentId]
    if (!pending) return
    inbox.withdraw(pending.pane, pending.key)
    delete store.state.notes[agentId]
    saveQuietly()
  }

  /** Give each local agent the roster note it has not read: through its hook only, never typed. */
  function notesPump(): void {
    if (!directory.current()) return
    const unknown: Member[] = []
    const alive = new Set(live().map((s) => s.agentId))
    // A note for a harness that is gone or stopped is withdrawn: its pane number may be another's next.
    for (const agentId of Object.keys(store.state.notes)) if (!alive.has(agentId)) withdrawNote(agentId)
    for (const session of live()) {
      const pending = store.state.notes[session.agentId]
      if (pending && inbox.claimed(pending.pane, pending.key)) {
        store.state.noted[session.agentId] = pending.signature
        delete store.state.notes[session.agentId]
        saveQuietly()
      }
      const roster = rosterOf(session.agentId)
      if (!roster) { withdrawNote(session.agentId); continue }
      // Only another machine can name its agents: a teammate here with no harness is stopped, and has no name to ask.
      unknown.push(...directory.peers({ machineId: self(), agentId: session.agentId }).filter((m) => m.machineId !== self() && !teammate(m).known))
      if (store.state.noted[session.agentId] === roster.signature) { withdrawNote(session.agentId); continue }
      const current = store.state.notes[session.agentId]
      if (current?.signature === roster.signature && current.pane === session.tmuxPane && inbox.waiting(current.pane, current.key)) continue
      withdrawNote(session.agentId)
      const noteKey = `0note-${roster.signature}`
      try {
        inbox.put(session.tmuxPane, noteKey, { session: session.sessionId ?? '', text: roster.text })
        store.state.notes[session.agentId] = { pane: session.tmuxPane, key: noteKey, signature: roster.signature }
        saveQuietly()
      } catch { /* the next look puts it */ }
    }
    if (unknown.length) void learnNames(unknown, false)
  }

  // ── sending ──────────────────────────────────────────────────────────────────────────────────────

  async function send(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const pane = typeof payload.pane === 'string' ? payload.pane : ''
    if (!PANE.test(pane)) throw new MessageError('NOT_A_HARNESS', 'Run harness send from a harness pane.')
    const session = live().find((s) => s.tmuxPane === pane)
    if (!session) throw new MessageError('NOT_A_HARNESS', 'This pane is not a harness Harness knows. Run harness send from an agent\'s pane.')
    if (!await directory.refresh()) throw new MessageError('DIRECTORY_UNAVAILABLE', 'Harness could not read which tabs have Agent Messages on. Try again in a moment.')
    const me = { machineId: self(), agentId: session.agentId }
    const inTabs = directory.peers(me)
    const links = linked(me).filter((m) => !inTabs.some((p) => same(p, m)))
    const peers = [...inTabs, ...links]
    if (!directory.tabsOf(me).length && !links.length) throw new MessageError('MESSAGES_OFF', 'Agent Messages are off in this tab. The person turns them on with the chat icon on the tab, or the tab\'s right-click menu.')
    await learnNames(peers, true)
    const mates = peers.map(teammate)
    const names = (Array.isArray(payload.to) ? payload.to : typeof payload.to === 'string' ? payload.to.split(',') : [])
      .map((n) => String(n).trim()).filter(Boolean)
    const text = typeof payload.text === 'string' ? payload.text : ''
    // No recipient and no text: who is here, the rules, and this agent's last messages. An agent whose context
    // was compacted asks this to learn again what it was told: seen on a real team, one rebuilt it from its team
    // history in five commands.
    if (!names.length && !text) {
      const started = links.length ? linkedNote(links) : null
      return { roster: [rosterOf(session.agentId)?.text, started].filter(Boolean).join('\n\n') || 'No teammates in this tab yet.', recent: recentFor(me) }
    }
    if (!names.length) throw new MessageError('USAGE', 'Name who to message: harness send <name> "text"')
    if (!text.trim()) throw new MessageError('USAGE', 'Write the message: harness send <name> "text"')
    if (text.length > LIMITS.text) throw new MessageError('TOO_LONG', `A message holds at most ${LIMITS.text} characters.`)
    const recipients: Recipient[] = []
    for (const name of names) {
      const wanted = name.toLowerCase()
      const exact = mates.filter((m) => m.name.toLowerCase() === wanted)
      const prefix = exact.length ? exact : mates.filter((m) => m.name.toLowerCase().startsWith(wanted))
      // Or the start of its id: a name is the session's title until someone names it, and a title can hold a comma,
      // which the recipient list splits on (a harness that started another tells it its id to answer to).
      const found = prefix.length || wanted.length < 6 ? prefix : mates.filter((m) => m.member.agentId.toLowerCase().startsWith(wanted))
      const list = mates.map((m) => m.name).join(', ') || 'nobody yet'
      if (!found.length) throw new MessageError('UNKNOWN_RECIPIENT', `No teammate named "${name}" in this tab. Teammates: ${list}.`)
      if (found.length > 1) throw new MessageError('AMBIGUOUS_RECIPIENT', `"${name}" could be ${found.map((m) => m.name).join(' or ')}. Use more of the name.`)
      if (!recipients.some((r) => r.machineId === found[0].member.machineId && r.agentId === found[0].member.agentId)) {
        recipients.push({ ...found[0].member, name: found[0].name })
      }
    }
    if (recipients.length > LIMITS.recipients) throw new MessageError('TOO_MANY_RECIPIENTS', `A message goes to at most ${LIMITS.recipients} teammates.`)
    const times = (sent.get(session.agentId) ?? []).filter((t) => now() - t < LIMITS.window)
    if (times.length >= LIMITS.perSender) {
      core.clients.windows({ type: 'messages_changed', payload: { limited: { machineId: self(), agentId: session.agentId } } })
      throw new MessageError('RATE_LIMITED', `This harness sent ${LIMITS.perSender} messages in 10 minutes. Wait, or work on without its teammates for now.`)
    }
    if (store.state.local.filter((d) => d.state === 'queued').length >= LIMITS.waiting) {
      throw new MessageError('MAILBOX_FULL', 'Too many messages are waiting on this machine. Try again once some are delivered.')
    }
    sent.set(session.agentId, [...times, now()])
    const tab = directory.shared(me, recipients[0]) ?? STARTED_TAB
    const message: Message = {
      id: messageId(), tabId: tab.id, to: recipients, text, at: now(),
      from: { ...me, name: core.agents.displayName(session) || session.agentId.slice(0, 8), engine: session.engine, machine: machineName(self()) },
    }
    store.record(message)
    for (const r of recipients) store.status({ messageId: message.id, machineId: r.machineId, agentId: r.agentId, state: 'queued', at: now() })
    for (const r of recipients.filter((r) => r.machineId === self())) mailbox.accept(message, r.agentId)
    for (const machineId of new Set(recipients.filter((r) => r.machineId !== self()).map((r) => r.machineId))) {
      store.state.outbox.push({ messageId: message.id, machineId, nextTryAt: now(), tries: 0 })
    }
    saveQuietly()
    await handOver(message.id)
    tellWindows(message.id)
    const entry = store.entry(message.id)!
    return {
      id: message.id, tab: tab.name,
      recipients: recipients.map((r) => {
        const status = entry.statuses.find((s) => s.machineId === r.machineId && s.agentId === r.agentId)
        return { name: r.name, state: status?.state ?? 'queued', ...(status?.via ? { via: status.via } : {}), ...(status?.reason ? { reason: status.reason } : {}) }
      }),
    }
  }

  /** The last messages a harness sent or was sent, oldest first, as `harness send` lists them. */
  function recentFor(me: Member, count = 5): Array<Record<string, unknown>> {
    const mine = (m: Member) => m.machineId === me.machineId && m.agentId === me.agentId
    return store.state.history.filter((e) => mine(e.message.from) || e.message.to.some(mine)).slice(-count).map((e) => {
      const sent = mine(e.message.from)
      const status = sent ? e.statuses.find((s) => s.state !== 'delivered') ?? e.statuses[0] : e.statuses.find((s) => mine(s))
      return { id: e.message.id, at: e.message.at, ...(sent ? { to: e.message.to.map((r) => r.name) } : { from: e.message.from.name }),
        text: e.message.text, state: status?.state ?? 'queued' }
    })
  }

  /** Hand what waits in the outbox to its machines: now for one message, or every one that is due. */
  async function handOver(onlyId?: string): Promise<void> {
    const due = store.state.outbox.filter((o) => (onlyId ? o.messageId === onlyId : now() >= o.nextTryAt))
    await Promise.all(due.map(async (outgoing) => {
      const entry = store.entry(outgoing.messageId)
      if (!entry) { store.state.outbox = store.state.outbox.filter((o) => o !== outgoing); return }
      try {
        const answer = await rpc(at(outgoing.machineId), { action: 'deliver', message: entry.message }, 10_000)
        store.state.outbox = store.state.outbox.filter((o) => o !== outgoing)
        applyRemote(outgoing.machineId, answer.statuses)
      } catch (error) {
        outgoing.tries += 1
        outgoing.nextTryAt = now() + Math.min(5 * 60_000, 5_000 * 2 ** Math.min(outgoing.tries, 6))
        outgoing.reason = error instanceof MessageError && error.code === 'NO_PEER_LINK' ? 'that machine is not paired with this one' : 'that machine is away: it is handed over once it is back'
        for (const r of entry.message.to.filter((r) => r.machineId === outgoing.machineId)) {
          if (store.status({ messageId: entry.message.id, machineId: r.machineId, agentId: r.agentId, state: 'queued', reason: outgoing.reason, at: now() })) tellWindows(entry.message.id)
        }
      }
    }))
    if (due.length) saveQuietly()
  }

  /** What another machine said became of its agents' deliveries. */
  function applyRemote(machineId: string, statuses: unknown): void {
    for (const s of Array.isArray(statuses) ? statuses as Record<string, unknown>[] : []) {
      if (typeof s.messageId !== 'string' || typeof s.agentId !== 'string' || !['queued', 'delivered', 'failed'].includes(String(s.state))) continue
      const status: DeliveryStatus = { messageId: s.messageId, machineId, agentId: s.agentId, state: s.state as DeliveryStatus['state'],
        ...(s.via === 'hook' || s.via === 'prompt' ? { via: s.via } : {}), ...(typeof s.reason === 'string' ? { reason: s.reason } : {}), at: now() }
      if (store.status(status)) tellWindows(status.messageId)
    }
  }

  /** Ask other machines what became of this machine's messages still waiting there. */
  async function remoteStatus(): Promise<void> {
    const waiting = new Map<string, string[]>()
    for (const entry of store.state.history) {
      if (entry.message.from.machineId !== self()) continue
      for (const s of entry.statuses) {
        if (s.machineId === self() || s.state !== 'queued' || store.state.outbox.some((o) => o.messageId === entry.message.id && o.machineId === s.machineId)) continue
        waiting.set(s.machineId, [...new Set([...(waiting.get(s.machineId) ?? []), entry.message.id])])
      }
    }
    await Promise.all([...waiting].map(async ([machineId, ids]) => {
      try { applyRemote(machineId, (await rpc(at(machineId), { action: 'status', ids: ids.slice(-200) }, 10_000)).statuses) } catch { /* asked again later */ }
    }))
    if (waiting.size) saveQuietly()
  }

  // ── another machine's requests ───────────────────────────────────────────────────────────────────

  async function deliver(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const message = parseMessage(payload.message)
    if (!message) throw new MessageError('INVALID_MESSAGE', 'That is not a message.')
    // This machine's own harnesses send through `send`, which names them by their pane: never as another's.
    if (message.from.machineId === self()) throw new MessageError('NOT_FROM_THERE', 'A message from this machine is sent here, not handed over.')
    if (!await directory.refresh()) throw new MessageError('DIRECTORY_UNAVAILABLE', 'Harness could not read which tabs have Agent Messages on. It is handed over again later.')
    if (store.state.local.filter((d) => d.state === 'queued').length >= LIMITS.waiting) {
      throw new MessageError('MAILBOX_FULL', 'Too many messages are waiting on that machine. It is handed over again later.')
    }
    const known = store.entry(message.id)
    if (!known) store.record(message)
    const statuses: DeliveryStatus[] = []
    for (const r of message.to.filter((r) => r.machineId === self())) {
      if (!known && !store.state.local.some((d) => d.messageId === message.id && d.agentId === r.agentId)) {
        if (directory.current() && !directory.shared(message.from, r)) {
          store.status({ messageId: message.id, machineId: self(), agentId: r.agentId, state: 'failed', reason: 'it is not in a tab with Agent Messages on with the sender', at: now() })
        } else {
          store.status({ messageId: message.id, machineId: self(), agentId: r.agentId, state: 'queued', at: now() })
          mailbox.accept(message, r.agentId)
        }
      }
      const s = store.entry(message.id)!.statuses.find((x) => x.machineId === self() && x.agentId === r.agentId)
      if (s) statuses.push(s)
    }
    saveQuietly()
    tellWindows(message.id)
    return { statuses }
  }

  function statusOf(payload: Record<string, unknown>): Record<string, unknown> {
    const ids = Array.isArray(payload.ids) ? payload.ids.filter((id): id is string => typeof id === 'string').slice(0, 200) : []
    return { statuses: ids.flatMap((id) => store.entry(id)?.statuses.filter((s) => s.machineId === self()) ?? []) }
  }

  function whoAre(payload: Record<string, unknown>): Record<string, unknown> {
    const ids = Array.isArray(payload.agentIds) ? payload.agentIds.filter((id): id is string => typeof id === 'string').slice(0, 64) : []
    return { agents: ids.flatMap((agentId) => {
      const session = localAgent(agentId)
      return session ? [{ agentId, name: core.agents.displayName(session) || agentId.slice(0, 8), engine: session.engine, ...(session.cwd ? { project: basename(session.cwd) } : {}) }] : []
    }) }
  }

  function history(payload: Record<string, unknown>): Record<string, unknown> {
    const tabId = typeof payload.tabId === 'string' ? payload.tabId : null
    const limit = typeof payload.limit === 'number' && payload.limit > 0 ? Math.min(payload.limit, LIMITS.history) : 200
    const entries = store.state.history.filter((e) => !tabId || e.message.tabId === tabId)
    return { messages: entries.slice(-limit).map((e) => ({ ...e.message, statuses: e.statuses })) }
  }

  /**
   * Inbox files nothing here is waiting to deliver, from a service that stopped or a daemon long gone (the inboxes
   * are every daemon's on this computer): removed once they are old enough not to be another live daemon's
   * delivery in the making, which that daemon puts back anyway.
   */
  function sweep(): void {
    const ours = new Set([
      ...store.state.local.filter((d) => d.state === 'queued' && d.pane).map((d) => `${d.pane}/${d.key}`),
      ...Object.values(store.state.notes).map((n) => `${n.pane}/${n.key}`),
    ])
    for (const entry of inbox.entries()) {
      if (!ours.has(`${entry.pane}/${entry.key}`) && now() - entry.at > SWEEP_AFTER_MS) inbox.withdraw(entry.pane, entry.key)
    }
  }

  function saveQuietly(): void {
    try { store.save() } catch { /* kept in memory; the next change saves again */ }
  }

  const stopHearing = core.turns.onDelivery((event: TurnDelivery) => mailbox.observe(event))
  const stopNotices = core.account.onNotice((notice) => { if (notice.type === 'desk_changed') void directory.refresh(true) })

  return {
    requests: {
      agent_messages: (payload, asker) => Promise.resolve().then(async () => {
        if (!asker.owner) throw new MessageError('OWNER_REQUIRED', 'Agent Messages answer only the owner.')
        // A pane is only this machine's to name; a hand-over, its status and its names are another machine's
        // daemon's to ask, over the relay, never a process here's.
        const fromHere = ['send'].includes(String(payload.action))
        if (['send', 'deliver', 'status', 'who', 'started'].includes(String(payload.action)) && asker.local !== fromHere) {
          throw new MessageError(fromHere ? 'LOCAL_ONLY' : 'REMOTE_ONLY', fromHere ? 'harness send runs in a pane on this machine.' : 'Only another of your machines hands messages over.')
        }
        switch (payload.action) {
          case 'send': return send(payload)
          case 'deliver': return deliver(payload)
          case 'status': return statusOf(payload)
          case 'who': return whoAre(payload)
          case 'started': return started(payload)
          case 'history': return history(payload)
          default: throw new MessageError('UNKNOWN_ACTION', 'Unknown Agent Messages request.')
        }
      }).catch((error: unknown) => (error instanceof MessageError
        ? { error: error.code, detail: error.message }
        : { error: 'MESSAGES_UNAVAILABLE', detail: 'Agent Messages are unavailable right now. Nothing was sent.' })),
    },
    canWrite: (deliveryId) => mailbox.canWrite(deliveryId),
    reconnected: () => mailbox.takeBackAttempts(),
    start: () => {
      directory.start()
      mailbox.start()
      sweep()
      timer = setInterval(() => {
        notesPump()
        void handOver()
        if (now() - lastRemoteStatus >= REMOTE_STATUS_MS) { lastRemoteStatus = now(); void remoteStatus() }
      }, TICK_MS)
      timer.unref?.()
    },
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
      stopHearing()
      stopNotices()
      mailbox.stop()
      directory.stop()
    },
  }
}
