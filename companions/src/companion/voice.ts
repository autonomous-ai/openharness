/**
 * The daemon's voice, as the pair brain speaks it (daemons/README.md "Voice", BRAIN.md "Three tiers").
 *
 * Two halves:
 *   - LINES: the paired daemon's roster line for the mood is a TEMPLATE with slots — `{who}` the harness
 *     (`name`, or `name@machine` off this computer), `{q}` the question, `{recap}` the turn's recap or why
 *     it failed, `{n}` the count that matters for the mood, `{summary}` the brief's facts. Slots are filled
 *     from the event, verbatim; the daemon's own words keep their case and their digits. A line whose slot
 *     cannot be filled is dropped for a neutral fact line — never shown with a made-up fact. A template
 *     that leaves out a fact the mood must carry (who is waiting, what was asked) gets it appended.
 *   - PairVoice: whether a line may be said at all. Silent by default. Only what needs you takes over the
 *     status line — a question and a failure (and a report of something the daemon did on its own); a
 *     finished turn is a count in `daemon_state`, not a line. At most one line nobody asked for every two
 *     minutes. A line shows for 5.2 s and its keys work only while it shows; after that the question
 *     stays in `daemon_state.needs` for the person to open. Never the same line twice.
 *
 * Everything goes out through `sendLocal` — loopback only. `send()` would upload it, unencrypted.
 */
import { PAIR_ROSTER } from './roster.g.js'
import { statusText, type DaemonAction, type DaemonMood, type DaemonSay } from './protocol.js'

type Mood = keyof (typeof PAIR_ROSTER.daemons)[number]['lines']
export type Slot = 'who' | 'q' | 'recap' | 'n' | 'summary'
export type Slots = Partial<Record<Slot, string | number | null>>

export function rosterDaemon(daemonId: string): (typeof PAIR_ROSTER.daemons)[number] | null {
  return PAIR_ROSTER.daemons.find((d) => d.id === daemonId) ?? null
}

export function rosterLine(daemonId: string, mood: Mood): string | null {
  return rosterDaemon(daemonId)?.lines[mood] ?? null
}

export function isRosterDaemon(id: unknown): id is string {
  return typeof id === 'string' && PAIR_ROSTER.daemons.some((d) => d.id === id)
}

/**
 * Fill a template's slots with facts. Null when a slot it names has no value: the line would otherwise
 * claim something nobody said. A slot the roster does not know is left as written (the generator refuses
 * such a roster; this never invents a meaning for one).
 */
export function fillLine(template: string, slots: Slots): string | null {
  let missing = false
  const known = PAIR_ROSTER.lineSlots as readonly string[]
  const filled = template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!known.includes(name)) return whole
    const value = slots[name as Slot]
    const text = value === null || value === undefined ? '' : statusText(String(value), 160)
    if (!text) { missing = true; return whole }
    return text
  })
  return missing ? null : filled
}

/**
 * A line of the daemon's own words, safe for any status line: one line, printable 7-bit ASCII, bounded —
 * but its spacing kept (zsh's `[1]  + done`, vim's `:earlier  …` are laid out on purpose). Facts put into
 * it are flattened on the way in (fillLine).
 */
export function lineText(value: string, max: number): string {
  const flat = value.replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7e]/g, '').trim()
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 3)).trimEnd()}...` : flat
}

/** `[y/n/g] ` — the keys a line offers, FIRST, so a narrow pane that cuts the end still shows them. */
export function keysPrefix(actions: readonly { key: string }[]): string {
  const keys = (['y', 'n', 's', 'g'] as const).filter((k) => actions.some((a) => a.key === k))
  return keys.length ? `[${keys.join('/')}] ` : ''
}

/** How an appended fact reads when a template leaves it out. */
const APPEND: Record<Slot, (value: string) => string> = {
  who: (v) => ` (${v})`,
  q: (v) => `: ${v}`,
  recap: (v) => ` ${v}`,
  n: (v) => ` (${v})`,
  summary: (v) => ` ${v}.`,
}

/**
 * The daemon's line for a mood with these facts: its template filled, with every `required` fact present
 * (appended when the template has no slot for it), or `fallback` when a slot cannot be filled.
 */
export function voicedLine(daemonId: string, mood: Mood, slots: Slots, required: Slot[], fallback: string): string {
  const template = rosterLine(daemonId, mood)
  const filled = template ? fillLine(template, slots) : null
  if (template === null || filled === null) return fallback
  let line = filled.replace(/\s+$/, '')
  for (const slot of required) {
    const value = slots[slot]
    if (value === null || value === undefined || template.includes(`{${slot}}`)) continue
    const text = statusText(String(value), 160)
    if (text) line += APPEND[slot](text)
  }
  return line
}

export interface LineFacts {
  /** The harness, as the person names it: `api`, or `api@laptop` when it is on another machine. */
  who: string
}

/** A question, keys first: `[y/n/g] bell in api@office: Bash: npm test`. */
export function needLine(daemonId: string, facts: LineFacts & { question: string; count?: number },
  actions: readonly { key: string }[]): string {
  const q = statusText(facts.question, 90)
  const line = voicedLine(daemonId, 'need', { who: facts.who, q, n: facts.count ?? 1 }, ['who', 'q'], `${facts.who}: ${q}`)
  return lineText(`${keysPrefix(actions)}${line}`, 140)
}

export function failLine(daemonId: string, facts: LineFacts & { reason: string }): string {
  const reason = statusText(facts.reason, 90) || 'failed'
  return lineText(voicedLine(daemonId, 'fail', { who: facts.who, recap: reason }, ['who', 'recap'], `${facts.who} failed: ${reason}`), 140)
}

/** A finished turn, for a client that wants the daemon's words for its `+n` (never spoken on its own). */
export function doneLine(daemonId: string, facts: LineFacts & { recap?: string | null; count?: number }): string {
  const recap = facts.recap ? statusText(facts.recap, 90) : null
  const fallback = recap ? `${facts.who} finished: ${recap}` : `${facts.who} finished.`
  return lineText(voicedLine(daemonId, 'done', { who: facts.who, recap, n: facts.count ?? 1 }, ['who'], fallback), 140)
}

/** Something the daemon did without a key (a pair.jsonc rule, or the pair driving a harness it started). */
export function autoLine(facts: LineFacts & { by: 'rule' | 'pair'; text: string }): string {
  return statusText(`${facts.by}: ${facts.who} ${facts.text}`, 140)
}

export interface BackFacts {
  done: number
  waiting: number
  /** How long the oldest open question has waited. */
  oldestWaitMs: number | null
  awayMs: number
  /** Harnesses that failed while you were away, by name. */
  failed: string[]
  /** Machines that should have answered and did not, by name. */
  unreachable: string[]
  /** Machines the account says are asleep (offline): named calmly, never as a failure. */
  asleep: string[]
  /** Machines asked, this one included. */
  machines: number
  /** Harnesses with anything to report, and how many are watched. */
  changed: number
  total: number
}

/** The brief's facts as one phrase — `{summary}`: "2 done, 1 waiting 40m, api failed, laptop asleep". */
export function summaryOf(facts: BackFacts): string {
  const parts: string[] = []
  if (facts.done) parts.push(`${facts.done} done`)
  if (facts.waiting) parts.push(`${facts.waiting} waiting${facts.oldestWaitMs != null ? ` ${ago(facts.oldestWaitMs)}` : ''}`)
  for (const name of facts.failed) parts.push(`${name} failed`)
  for (const machine of facts.unreachable) parts.push(`${machine} unreachable`)
  for (const machine of facts.asleep) parts.push(`${machine} asleep`)
  return parts.length ? parts.join(', ') : 'nothing new'
}

/** The line on return: "reattached. 2 done, 1 waiting 40m." — every daemon says the same facts. */
export function backLine(daemonId: string, facts: BackFacts): string {
  const summary = summaryOf(facts)
  return lineText(voicedLine(daemonId, 'back', { summary, n: facts.done }, ['summary'], `welcome back. ${summary}.`), 160)
}

export function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (minutes < 120) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

// ── when it may speak ───────────────────────────────────────────────────────────────────────────────

/** How long a line shows (tmux's message line) — and how long its keys work. */
export const DISPLAY_MS = 5_200
/** At most one line nobody asked for this often. */
export const UNSOLICITED_GAP_MS = 2 * 60_000
export const SAY_WINDOW_MS = 60_000
export const SAY_WINDOW_MAX = 6
const SPOKEN_MAX = 500

/** Lines nobody asked for. `back` (you returned), `say` (the pair answering you) and `ask` (a proposal
 *  you asked the pair for) answer something the person did. */
const UNSOLICITED = new Set<DaemonMood>(['need', 'fail', 'auto', 'done'])

export interface PairVoiceDeps {
  /** Loopback only: backendSocket.sendLocal. */
  sendLocal: (frame: Record<string, unknown>) => void
  now: () => number
}

interface Live { say: DaemonSay; at: number }

export class PairVoice {
  private readonly live = new Map<string, Live>()
  /** Every id ever said, bounded — a line is said once, whatever reconnects in between. */
  private readonly spoken = new Set<string>()
  private readonly recent: number[] = []
  private lastUnsolicited = -Infinity

  constructor(private readonly deps: PairVoiceDeps) {}

  /**
   * Say it, unless it was said already or the voice is over its limits. True when it went out. `always`:
   * a change to what the daemon may do (pair/gate.ts) — it is said whatever the limits, once.
   */
  say(say: DaemonSay, opts: { always?: boolean } = {}): boolean {
    const now = this.deps.now()
    this.sweep(now)
    if (this.spoken.has(say.id)) return false
    const unsolicited = UNSOLICITED.has(say.mood) && !opts.always
    if (unsolicited && now - this.lastUnsolicited < UNSOLICITED_GAP_MS) return false
    while (this.recent.length && now - this.recent[0] >= SAY_WINDOW_MS) this.recent.shift()
    // A proposal is the one thing worth saying over the per-minute window: nothing happens until it is heard.
    if (this.recent.length >= SAY_WINDOW_MAX && say.mood !== 'ask' && !opts.always) return false
    this.recent.push(now)
    if (unsolicited) this.lastUnsolicited = now
    this.remember(say.id)
    this.live.set(say.id, { say, at: now })
    this.deps.sendLocal({ type: 'daemon_say', payload: say })
    return true
  }

  /**
   * Replace a line still showing, in place (`daemon_say` again, same id): the model's better words, or
   * keys that changed. It keeps the time it has left — a replacement never extends how long keys work.
   */
  replace(id: string, fields: { line: string; actions: DaemonAction[] }): boolean {
    const now = this.deps.now()
    this.sweep(now)
    const live = this.live.get(id)
    if (!live) return false
    const say: DaemonSay = { ...live.say, line: fields.line, actions: fields.actions }
    this.live.set(id, { say, at: live.at })
    this.deps.sendLocal({ type: 'daemon_say', payload: { ...say, ttlMs: Math.max(0, live.say.ttlMs - (now - live.at)) } })
    return true
  }

  /**
   * Keys that live in something else the person is looking at (a brief item), not a status line: held
   * for `say.ttlMs` so `daemon_act` can find them, never sent as `daemon_say`.
   */
  hold(say: DaemonSay): void {
    const now = this.deps.now()
    this.sweep(now)
    this.live.set(say.id, { say, at: now })
  }

  /** Take back a line still showing — answered elsewhere, or the harness went away. */
  unsay(id: string, reason: string): boolean {
    if (!this.live.delete(id)) return false
    this.deps.sendLocal({ type: 'daemon_unsay', payload: { id, reason } })
    return true
  }

  /** Every live line about this harness (and question, when given). */
  unsayAbout(machineId: string, agentId: string, reason: string, requestId?: string): void {
    for (const [id, { say }] of [...this.live]) {
      if (say.about.machineId !== machineId || say.about.agentId !== agentId) continue
      if (requestId !== undefined && say.about.requestId !== requestId) continue
      this.unsay(id, reason)
    }
  }

  /** A line still showing, for `daemon_act`. A line past its time is gone, and so are its keys. */
  get(id: string): DaemonSay | null {
    this.sweep(this.deps.now())
    return this.live.get(id)?.say ?? null
  }

  wasSaid(id: string): boolean { return this.spoken.has(id) }

  /** A line of this mood is showing (or its keys are held for a brief) right now. */
  showing(mood: DaemonMood): boolean {
    this.sweep(this.deps.now())
    for (const { say } of this.live.values()) if (say.mood === mood) return true
    return false
  }

  private sweep(now: number): void {
    for (const [id, { say, at }] of [...this.live]) if (now - at >= say.ttlMs) this.live.delete(id)
  }

  private remember(id: string): void {
    this.spoken.add(id)
    if (this.spoken.size > SPOKEN_MAX) this.spoken.delete(this.spoken.values().next().value as string)
  }
}

export type { DaemonMood }
