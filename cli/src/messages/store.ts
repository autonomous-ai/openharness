/**
 * What Agent Messages keeps on disk (`<data>/agent-messages/state.json`), private and written atomically:
 * - the history this machine saw: messages its agents sent or received, each with what became of it per
 *   recipient (the windows' log reads it);
 * - the deliveries this machine owns, to its own agents, until each is delivered or failed: a message never
 *   expires, so a restart must not lose one;
 * - the outbox: messages for another machine's agents not yet handed to that machine;
 * - which roster each local agent was last told (the note).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inboxPaneKey } from './inbox.js'
import { LIMITS, parseMessage, type DeliveryState, type DeliveryStatus, type Message } from './model.js'

/** A delivery this machine makes to one of its own agents. */
export interface LocalDelivery {
  /** The inbox key: the message and the agent, safe as a file name. */
  key: string
  messageId: string
  agentId: string
  /** The pane the inbox file was put in, by its route key (inbox.ts), and the conversation it names; none while its
   *  harness is stopped. */
  pane: string
  session?: string
  state: DeliveryState
  via?: 'hook' | 'prompt' | 'read'
  reason?: string
  /**
   * A typed attempt the core was handed, under its own delivery id. `queuedAt`: when the core said it holds it;
   * `parked`: held behind a running turn, so given back to the hook and no longer writable.
   */
  attempt?: { id: string; at?: number; queuedAt?: number; parked?: boolean; parkedAt?: number }
  tries: number
  nextTryAt: number
  at: number
}

/** A message this machine sent, waiting to be handed to another machine. `sharedTabId`: the shared tab it goes through,
 *  to another account's machine; none for a machine of this account, over its paired relay. Kept with it, so a message
 *  for another account's harness is never handed to this account's relay later (service.ts `route`). */
export interface Outgoing { messageId: string; machineId: string; nextTryAt: number; tries: number; reason?: string; sharedTabId?: string }

export interface Entry { message: Message; statuses: DeliveryStatus[] }

export interface State {
  history: Entry[]
  local: LocalDelivery[]
  outbox: Outgoing[]
  /** Per local agent: the roster note it was last given, by signature. */
  noted: Record<string, string>
  /** Per local agent: the roster note waiting in its inbox, kept so a restart never orphans one. */
  notes: Record<string, { pane: string; key: string; signature: string }>
}

const empty = (): State => ({ history: [], local: [], outbox: [], noted: {}, notes: {} })

export class MessageStore {
  readonly file: string
  state: State
  /** The history by message id, kept with it: every pump looks each waiting delivery's message up. Rebuilt
   *  when the history is replaced as a whole. */
  private index = new Map<string, Entry>()
  private indexed: Entry[] | null = null
  constructor(readonly dir: string) {
    this.file = join(dir, 'state.json')
    this.state = this.load()
  }

  private load(): State {
    if (!existsSync(this.file)) return empty()
    let raw: Partial<State>
    try { raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<State> } catch {
      // Kept for a person to inspect, never read as an empty history that then overwrites it.
      renameSync(this.file, `${this.file}.unreadable-${Date.now()}`)
      return empty()
    }
    const history = (Array.isArray(raw.history) ? raw.history : []).flatMap((entry) => {
      const message = parseMessage(entry?.message)
      return message ? [{ message, statuses: Array.isArray(entry.statuses) ? entry.statuses : [] }] : []
    })
    // Written before panes were keyed by their backend, a pane is a bare tmux `%N`: read as that tmux pane's key,
    // so a delivery or a note made then is still the same inbox file, never one put again beside the hook's claim.
    const local = Array.isArray(raw.local) ? raw.local.filter((d) => d && typeof d.key === 'string' && typeof d.pane === 'string') : []
    for (const delivery of local) delivery.pane = inboxPaneKey(delivery.pane)
    const notes = raw.notes && typeof raw.notes === 'object' && !Array.isArray(raw.notes) ? raw.notes : {}
    for (const note of Object.values(notes)) if (note && typeof note.pane === 'string') note.pane = inboxPaneKey(note.pane)
    return {
      history,
      local,
      outbox: Array.isArray(raw.outbox) ? raw.outbox.filter((o) => o && typeof o.messageId === 'string' && (o.sharedTabId === undefined || typeof o.sharedTabId === 'string')) : [],
      noted: raw.noted && typeof raw.noted === 'object' ? raw.noted : {},
      notes,
    }
  }

  save(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    chmodSync(this.dir, 0o700)
    const temporary = `${this.file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 })
    renameSync(temporary, this.file)
  }

  entry(messageId: string): Entry | undefined {
    if (this.indexed !== this.state.history) {
      this.index = new Map(this.state.history.map((e) => [e.message.id, e]))
      this.indexed = this.state.history
    }
    return this.index.get(messageId)
  }

  /** Record a message, once. Keeps each tab's newest `LIMITS.history`, never one still waiting here. */
  record(message: Message): Entry {
    const known = this.entry(message.id)
    if (known) return known
    const entry: Entry = { message, statuses: [] }
    this.state.history.push(entry)
    if (this.indexed === this.state.history) this.index.set(message.id, entry)
    const tab = this.state.history.filter((e) => e.message.tabId === message.tabId)
    const waiting = new Set([...this.state.local.filter((d) => d.state === 'queued').map((d) => d.messageId), ...this.state.outbox.map((o) => o.messageId)])
    for (const old of tab.slice(0, Math.max(0, tab.length - LIMITS.history))) {
      if (!waiting.has(old.message.id)) {
        this.state.history.splice(this.state.history.indexOf(old), 1)
        this.index.delete(old.message.id)
      }
    }
    return entry
  }

  /** Set what became of a message for one recipient; true when it changed. */
  status(status: DeliveryStatus): boolean {
    const entry = this.entry(status.messageId)
    if (!entry) return false
    const at = entry.statuses.findIndex((s) => s.machineId === status.machineId && s.agentId === status.agentId)
    const prior = at >= 0 ? entry.statuses[at] : undefined
    // A final state is final: a late "queued" from another machine never undoes a delivery.
    if (prior && prior.state !== 'queued' && status.state === 'queued') return false
    if (prior && prior.state === status.state && prior.via === status.via && prior.reason === status.reason) return false
    if (at >= 0) entry.statuses[at] = status
    else entry.statuses.push(status)
    return true
  }
}
