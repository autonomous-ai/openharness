/**
 * The pair brain: the half that thinks, run by the harnessd of the computer you are at — the one with a
 * window or `hn` attached (daemons/BRAIN.md). Every other daemon only senses.
 *
 * It keeps the fleet (pair/fleet.ts) while a client is attached, speaks when something needs you (the
 * template line AT ONCE, then — opt-in — a model's better words in place: pair/triage.ts), keeps a count
 * of finished turns rather than saying them, and turns a key the person pressed (`daemon_act`) into an
 * answer on the machine that owns the harness.
 *
 * Local frames only, and only through `sendLocal`/`sendLocalTo`:
 *   out  daemon_state { pair, needs[], working, failing[], machines[], done, asks[], acted[], autonomy,
 *                        autonomyRequested?, confirms[] }   (on change, to a new client, and to every
 *                        client when pairing or the daemons switch changes: refresh)
 *        daemon_say / daemon_unsay         (pair/voice.ts)
 *        daemon_brief { desk, line, items[] }   (on return, pair/brief.ts; a lesson's [s], pair/learn)
 *        daemon_act_result { requestId, id, ok, error? }   (to the client that acted)
 *        daemon_confirm_result, daemon_talk_result         (likewise)
 *   in   daemon_shown { id }, daemon_act { requestId, id, choice }, daemon_confirm { requestId, kind, nonce, accept },
 *        daemon_talk { requestId, text },
 *        daemon_presence { active, awayMs, pair?, desk?, focusAgentId?, focusMachineId?, doneSeen?, autonomy?, consent? }
 *
 * Baselines are never news: a snapshot from a machine (re)connecting, a replay, a question already open
 * when this daemon started. Only a journal entry that arrives live makes it speak — and never about the
 * pane the person is looking at.
 */
import type { PairFleet, FleetChange, FleetHarness } from './fleet.js'
import type { PairTriage, TriageInput } from './triage.js'
import { actionsFor } from './triage.js'
import { autoLine, backLine, DISPLAY_MS, failLine, keysPrefix, type PairVoice } from './voice.js'
import { composeBrief } from './brief.js'
import { str, type DaemonAction, type PairJournalEntry } from './protocol.js'
import type { Autonomy } from './floor.js'
import type { ShownLines } from './shown.js'
import { RateLimit } from './limit.js'
import type { ConfirmRequest, GateEvent } from './gate.js'

/** Keys this brain relays to other machines: a minute's worth and an hour's (the owner limits them too). */
export const RELAY_LIMITS = [{ windowMs: 60_000, max: 6 }, { windowMs: 60 * 60_000, max: 60 }]
/** Talks to the pair harness: each is a model turn the person pays for. */
export const TALK_LIMITS = [{ windowMs: 60_000, max: 6 }, { windowMs: 60 * 60_000, max: 60 }]
export const TALK_COST_NOTE = 'Each talk is a turn of your pair harness on its engine: it spends your model usage.'

/** An absence this long is a return worth a brief (daemons/README.md: `back` after 15 minutes). */
export const BRIEF_AWAY_MS = 15 * 60_000
/** Each machine's journal gets this long to answer before it is named as unreachable. */
export const BRIEF_JOURNAL_MS = 3_000
/** A brief's waiting items keep their keys this long: the brief is something the person is looking at. */
export const BRIEF_KEYS_MS = 60_000
/** Finished turns and automatic actions kept for daemon_state. */
const RECENT_MAX = 5
const STATE_DEBOUNCE_MS = 150

export type AnswerResult = { ok: boolean; error?: string; detail?: string }

export interface PairBrainDeps {
  /** This machine's sensor: the switch, and which daemon is paired. */
  pairing: { enabled: () => boolean; pairedDaemon: () => string | null }
  fleet: PairFleet
  triage: PairTriage
  voice: PairVoice
  /** Loopback only (backendSocket.sendLocal / sendLocalTo): never `send()`, which uploads. */
  sendLocal: (frame: Record<string, unknown>) => void
  sendLocalTo: (connId: string, frame: Record<string, unknown>) => boolean
  /**
   * Key an answer into a question on THIS machine: the owner's floor (pair/owner.ts), then
   * AskQuestionController, which types nothing unless the dialog on screen is still `requestId`
   * (STALE_QUESTION otherwise). The brain has already checked the question is the one the person saw.
   */
  answer: (input: { agentId: string; requestId: string; choice: string }) => Promise<AnswerResult>
  /** The autonomy dial (zoo `autonomy`). `watch`: lines carry only [g], and no key answers anything. */
  autonomy?: () => Autonomy
  /** The control interface's proposals (pair/control.ts): a key on one of its lines is its to run. */
  proposals?: {
    owns: (id: string) => boolean
    act: (id: string, choice: string) => Promise<Record<string, unknown>>
    pending: () => Array<{ id: string; line: string; actions: DaemonAction[] }>
  }
  /** A guest's window says which daemon its local zoo pairs (daemon_presence.pair), its dial, and whether
   *  the person agreed to being watched (`consent`, the first-day screen's answer). */
  onGuestPair?: (daemonId: string | null, identity?: unknown) => void
  onGuestAutonomy?: (autonomy: string | null) => void
  onGuestConsent?: (watching: boolean) => void
  /** The brain started or stopped thinking (cli.ts keeps the router's worker warm while it does). */
  onActiveChanged?: (active: boolean) => void
  /**
   * Which window was shown which line (pair/shown.ts). A key counts only from a window that received the
   * line and acknowledged it as displayed, ARM_MS before the key (`onKey`).
   */
  shown?: ShownLines
  /** `daemon_talk`: the person's words to the pair harness (pair/pairHarness.ts), which starts or wakes. */
  talk?: (text: string, companionUid?: string) => Promise<Record<string, unknown>>
  /** Open the pair's terminal without typing into it or starting a model turn. */
  open?: (companionUid?: string, engine?: 'claude' | 'codex' | 'opencode') => Promise<Record<string, unknown>>
  /** The collection's persistent agent and its observed model. Local windows only. */
  companionHarness?: () => Record<string, unknown>
  /** How many keys may be relayed to other machines, per window (RELAY_LIMITS unless a spec says). */
  relayLimits?: Array<{ windowMs: number; max: number }>
  /**
   * What waits for the person's yes (pair/gate.ts): listed in daemon_state `confirms`, answered with
   * `daemon_confirm` from a window that displayed it (`onConfirm`).
   */
  gate?: {
    requests: () => ConfirmRequest[]
    requestedAutonomy: () => Autonomy
    confirm: (kind: string, nonce: string, accept: boolean) => { ok: true; kind: string } | { ok: false; error: string; detail?: string }
  }
  /** Journal, on THIS machine, a key relayed to another one and the window it came from (PairSensor.relayed). */
  relayed?: (fields: { target: string; agentId: string; name: string; engine: string; requestId: string; text: string; origin: string }) => void
  /**
   * A key on a lesson's line (`lesson:<id>:<nonce>`) is the person's alone (pair/learn/approval.ts
   * `lessonKeyVerdict`): never a tool, never a process the daemon can see inside a harness pane. Asked after
   * the line was shown here; the nonce in the id is checked by the learner. Absent: a lesson key is refused.
   */
  lessonKey?: (connId: string) => Promise<{ ok: true } | { ok: false; error: string; detail: string }>
  lessonReview?: (id: string) => Record<string, unknown>
  now: () => number
}

interface Presence { active: boolean; at: number; focus: { machineId: string | null; agentId: string } | null }

/** The desk a client that names none is at: this computer. */
const LOCAL_DESK = 'local'

interface DoneItem { machineId: string; machine: string; agentId: string; name: string; recap: string | null; at: number }
interface ActedItem { machineId: string; machine: string; agentId: string; name: string; by: string; action: string; text: string; at: number }

export class PairBrain {
  private readonly clients = new Set<string>()
  private readonly presence = new Map<string, Presence>()
  private active = false
  private stateTimer: ReturnType<typeof setTimeout> | null = null
  private lastState = ''
  /** `${machineId}\0${requestId}` → the line said about it, so the state can carry its keys while it shows. */
  private readonly needSays = new Map<string, { id: string }>()
  /** Turns finished since the person last looked (`daemon_presence.doneSeen`, or a brief): the `+n`. */
  private doneCount = 0
  private doneLast: DoneItem[] = []
  private acted: ActedItem[] = []
  /**
   * When this daemon started. A restart is a baseline, not a return: an absence that began before it
   * (a window reconnecting because the daemon restarted under it) is never briefed.
   */
  private readonly startedAt: number
  /** Per desk: when the person was last seen leaving (presence went inactive, or the last client left). */
  private readonly departed = new Map<string, number>()
  /** Per desk: when it was last briefed — the cursor that stops a second client repeating the brief. */
  private readonly cursors = new Map<string, number>()

  private readonly relayLimit: RateLimit
  private readonly talkLimit: RateLimit
  private setSeq = 0

  constructor(private readonly deps: PairBrainDeps) {
    this.startedAt = deps.now()
    this.relayLimit = new RateLimit(deps.relayLimits ?? RELAY_LIMITS, deps.now)
    this.talkLimit = new RateLimit(TALK_LIMITS, deps.now)
  }

  get isActive(): boolean { return this.active }

  /** The windows (and `hn`) attached right now: whom a local frame reaches. */
  clientIds(): string[] { return [...this.clients] }

  private autonomy(): Autonomy { return this.deps.autonomy?.() ?? 'watch' }

  // ── who is here ───────────────────────────────────────────────────────────────────────────────────

  clientAttached(connId: string): void {
    const first = this.clients.size === 0
    this.clients.add(connId)
    // This window started the brain: every window here is told (it is the only one). Already thinking: the
    // others have the state, so only the new one is sent it.
    if (this.sync()) this.sendState(true)
    else if (this.active) this.deps.sendLocalTo(connId, { type: 'daemon_state', payload: this.state() })
    // Nobody was here and now somebody is: a reconnect after long enough is a return.
    const left = this.departed.get(LOCAL_DESK)
    if (first && left !== undefined) {
      this.departed.delete(LOCAL_DESK)
      this.returned(LOCAL_DESK, this.deps.now() - left)
    }
  }

  clientDetached(connId: string): void {
    this.clients.delete(connId)
    this.presence.delete(connId)
    this.deps.shown?.detach(connId)
    if (this.clients.size === 0 && !this.departed.has(LOCAL_DESK)) this.departed.set(LOCAL_DESK, this.deps.now())
    // It stops when the last window left (nobody to tell) — or, had pairing gone off unsaid, the rest are told.
    if (this.sync() && this.clients.size > 0) this.sendState(true)
  }

  /**
   * `daemon_presence { active, awayMs, pair?, desk?, focusAgentId?, focusMachineId?, doneSeen? }` from a window
   * or `hn`. A guest's `pair` and `autonomy` count only from a window bound to this machine (`meta.ui`).
   */
  onPresence(connId: string, payload: Record<string, unknown>, meta: { ui: boolean } = { ui: true }): void {
    if (meta.ui && 'consent' in payload) this.deps.onGuestConsent?.(payload.consent === true)
    if (meta.ui && 'pair' in payload) this.deps.onGuestPair?.(typeof payload.pair === 'string' ? payload.pair : null, payload.companion)
    if (meta.ui && 'autonomy' in payload) this.deps.onGuestAutonomy?.(typeof payload.autonomy === 'string' ? payload.autonomy : null)
    const prior = this.presence.get(connId)
    // What the person is looking at: never spoken about. `null` clears it; absent keeps what was said.
    let focus = prior?.focus ?? null
    if ('focusAgentId' in payload) {
      const agentId = str(payload.focusAgentId, 200)
      focus = agentId ? { agentId, machineId: str(payload.focusMachineId, 120) || null } : null
    }
    if (payload.doneSeen === true) this.clearDone()
    if (typeof payload.active !== 'boolean') {
      if (prior) this.presence.set(connId, { ...prior, focus })
      else if (focus) this.presence.set(connId, { active: true, at: this.deps.now(), focus })
      return
    }
    const now = this.deps.now()
    this.presence.set(connId, { active: payload.active, at: now, focus })
    const desk = str(payload.desk, 64) || LOCAL_DESK
    if (!payload.active) {
      if (!this.departed.has(desk)) this.departed.set(desk, now)
      return
    }
    // Back. The client's own measure of the absence counts (it knows about an idle keyboard this
    // daemon never sees), and so does a departure this daemon watched happen; the longer wins.
    const left = this.departed.get(desk)
    this.departed.delete(desk)
    const reported = typeof payload.awayMs === 'number' && Number.isFinite(payload.awayMs) ? Math.max(0, payload.awayMs) : 0
    this.returned(desk, Math.max(reported, left !== undefined ? now - left : 0))
  }

  /** The person is looking at this harness right now (a lesson is never proposed about it). */
  isFocused(machineId: string, agentId: string): boolean {
    return this.focused(machineId, agentId)
  }

  /** True when a client says the person is looking at this harness right now. */
  private focused(machineId: string, agentId: string): boolean {
    const local = this.deps.fleet.machines().find((m) => m.local)?.machineId
    for (const seen of this.presence.values()) {
      if (!seen.focus || !seen.active || seen.focus.agentId !== agentId) continue
      if ((seen.focus.machineId ?? local) === machineId) return true
    }
    return false
  }

  private clearDone(): void {
    if (!this.doneCount && !this.doneLast.length) return
    this.doneCount = 0
    this.doneLast = []
    this.scheduleState()
  }

  /** A return: brief it if it was long enough, began after this daemon did, and this desk was not just briefed. */
  private returned(desk: string, awayMs: number): void {
    const now = this.deps.now()
    if (!this.active || awayMs < BRIEF_AWAY_MS) return
    if (now - awayMs < this.startedAt) return
    const cursor = this.cursors.get(desk) ?? this.startedAt
    if (now - cursor < BRIEF_AWAY_MS) return
    this.cursors.set(desk, now)
    void this.brief(desk, Math.max(now - awayMs, cursor), awayMs)
  }

  /**
   * Gather every machine's journal since the person left (3 s each), say the back line, then send at most
   * five items — template facts, the waiting ones with their keys first.
   */
  private async brief(desk: string, since: number, awayMs: number): Promise<void> {
    const daemonId = this.deps.pairing.pairedDaemon()
    if (!daemonId) return
    const journals = await this.deps.fleet.journals(since, BRIEF_JOURNAL_MS)
    if (!this.active) return
    const now = this.deps.now()
    const { facts, items } = composeBrief({
      journals, harnesses: this.deps.fleet.harnesses(), machines: this.deps.fleet.machines(), awayMs, now,
    })
    const line = backLine(daemonId, facts)
    this.deps.voice.say({
      id: `back:${desk}:${now}`, mood: 'back', line, actions: [], ttlMs: DISPLAY_MS,
      about: { machineId: this.deps.fleet.machines()[0]?.machineId ?? '', agentId: '' },
    })
    // The brief is the count's reading: what finished is in it.
    this.clearDone()
    if (!items.length) return
    const watch = this.autonomy() === 'watch'
    const written = items.map(({ question, ...item }) => {
      if (item.kind !== 'waiting' || !question || !item.agentId) return item
      const actions = actionsFor(question, null, { watch, remote: !(this.deps.fleet.machines().find((m) => m.machineId === item.machineId)?.local ?? false) })
      const id = `brief:${item.machineId}:${question.requestId}:${now}`
      this.deps.voice.hold({ id, mood: 'need', line: item.line, actions, ttlMs: BRIEF_KEYS_MS,
        about: { machineId: item.machineId, agentId: item.agentId, requestId: question.requestId } })
      return { ...item, id, actions, line: `${keysPrefix(actions)}${item.line}`, ...(question.dialog !== undefined ? { detail: question.dialog } : {}) }
    })
    this.deps.sendLocal({ type: 'daemon_brief', payload: { desk, line, items: written } })
  }

  /** The person is at this computer: a client says so, or one is attached and has never said otherwise. */
  present(): boolean {
    for (const connId of this.clients) {
      const seen = this.presence.get(connId)
      if (!seen || seen.active) return true
    }
    return false
  }

  /**
   * Pairing, consent or the autonomy dial changed, or the daemons switch turned on or off (cli.ts): start or
   * stop thinking, and tell every window attached what daemon_state says now — the fleet's, or the off result
   * that sends it back to roster lines. A window attached before pairing came on hears it here, not on its
   * next reconnect. Idempotent: a start or a stop is always said, once; otherwise only a state the windows
   * were not already sent.
   */
  refresh(): void {
    const moved = this.sync()
    if (this.clients.size > 0) this.sendState(moved)
  }

  /** Start or stop thinking for the pairing and the windows there are now. True when it started or stopped. */
  private sync(): boolean {
    const should = this.deps.pairing.enabled() && this.clients.size > 0
    if (should === this.active) return false
    this.active = should
    this.deps.onActiveChanged?.(should)
    if (should) {
      this.deps.fleet.start()
    } else {
      this.deps.fleet.stop()
      this.needSays.clear()
      if (this.stateTimer) { clearTimeout(this.stateTimer); this.stateTimer = null }
    }
    return true
  }

  /** Something outside the fleet changed what daemon_state says (a proposal came or went). */
  stateChanged(): void {
    if (this.active) this.scheduleState()
  }

  // ── what the fleet reports ────────────────────────────────────────────────────────────────────────

  onFleetChange(change: FleetChange): void {
    if (!this.active) return
    this.scheduleState()
    const event = change.event
    if (!event) return
    // Something the daemon did on its own is reported afterwards, whatever became of the harness.
    if (!event.baseline && event.entry?.kind === 'act') this.actedEntry(change, event.entry)
    if (event.removed || !event.harness) {
      this.deps.voice.unsayAbout(change.machineId, event.agentId, 'gone')
      return
    }
    // A question that is no longer on the harness — however we learned it — takes its line with it.
    for (const [key, need] of [...this.needSays]) {
      const [machineId, requestId] = key.split('\u0000')
      if (machineId !== change.machineId) continue
      const say = this.deps.voice.get(need.id)
      if (!say) { this.needSays.delete(key); continue }
      if (say.about.agentId === event.agentId && event.harness.question?.requestId !== requestId) {
        this.needSays.delete(key)
        this.deps.voice.unsay(need.id, 'answered')
      }
    }
    if (event.baseline || !event.entry) return
    const entry = event.entry
    switch (entry.kind) {
      case 'question': void this.need(change, entry); return
      case 'answered':
        this.deps.voice.unsayAbout(change.machineId, event.agentId, 'answered', entry.requestId)
        this.needSays.delete(`${change.machineId}\u0000${entry.requestId}`)
        return
      case 'done': this.done(change, entry); return
      case 'recap': this.recap(change, entry); return
      case 'fail': this.fail(change, entry); return
      default: return
    }
  }

  private who(h: FleetHarness | { local: boolean; machine: string; harness: { name: string } }): string {
    return h.local ? h.harness.name : `${h.harness.name}@${h.machine}`
  }

  /**
   * A new question: the template line at once, keys first, for as long as it shows. If a model is on and
   * comes back in time with better words, they replace the line in place — never delay it.
   */
  private async need(change: FleetChange, entry: PairJournalEntry): Promise<void> {
    const daemonId = this.deps.pairing.pairedDaemon()
    const harness = change.event?.harness
    const question = harness?.question
    if (!daemonId || !harness || !question || question.requestId !== entry.requestId) return
    this.scheduleState()
    // The person is looking at it: they can see the dialog. It stays in daemon_state.needs.
    if (this.focused(change.machineId, harness.agentId)) return
    const waiting = this.deps.fleet.harnesses().filter((h) => h.harness.question)
    const input: TriageInput = {
      daemonId, machineId: change.machineId, who: this.who({ local: change.local, machine: change.machine, harness }),
      engine: harness.engine, question, present: this.present(), count: Math.max(1, waiting.length), watch: this.autonomy() === 'watch',
      remote: !change.local,
    }
    const template = this.deps.triage.template(input)
    const id = `need:${change.machineId}:${entry.epoch}:${entry.seq}`
    const key = `${change.machineId}\u0000${question.requestId}`
    const said = this.deps.voice.say({
      id, mood: 'need', line: template.line, actions: template.actions, ttlMs: DISPLAY_MS,
      about: { machineId: change.machineId, agentId: harness.agentId, requestId: question.requestId },
      // What [y] would approve, in full: the window shows it before it acknowledges the line.
      ...(question.dialog !== undefined ? { detail: question.dialog } : {}),
      harness: { machineId: change.machineId, machine: change.machine, agentId: harness.agentId, name: harness.name },
    })
    if (!said) return
    this.needSays.set(key, { id })
    // Its keys stop working when it stops showing: tell the clients then, so none offers them after.
    setTimeout(() => this.scheduleState(), DISPLAY_MS + 50)
    const better = await this.deps.triage.refine(input)
    // Answered, or gone from the screen, while it was being thought about: nothing to improve.
    const still = this.deps.fleet.find(change.machineId, harness.agentId)
    if (!better || !this.active || still?.harness.question?.requestId !== question.requestId) return
    if (this.deps.voice.replace(id, { line: better.line, actions: better.actions })) this.scheduleState()
  }

  /** A finished turn is a count, not a line: clients show `+n` beside the daemon, cleared when you look. */
  private done(change: FleetChange, entry: PairJournalEntry): void {
    const harness = change.event?.harness
    if (!harness || entry.text === 'interrupted') return
    this.deps.voice.unsayAbout(change.machineId, harness.agentId, 'done')
    if (this.focused(change.machineId, harness.agentId)) return
    this.doneCount++
    this.doneLast = [
      { machineId: change.machineId, machine: change.machine, agentId: harness.agentId, name: this.who({ local: change.local, machine: change.machine, harness }), recap: null, at: entry.at },
      ...this.doneLast.filter((d) => !(d.machineId === change.machineId && d.agentId === harness.agentId)),
    ].slice(0, RECENT_MAX)
    this.scheduleState()
  }

  /** The recap is written after the turn ends: it joins the finished turn it belongs to. */
  private recap(change: FleetChange, entry: PairJournalEntry): void {
    const item = this.doneLast.find((d) => d.machineId === change.machineId && d.agentId === entry.agentId)
    if (!item || !entry.text) return
    item.recap = entry.text
    this.scheduleState()
  }

  private fail(change: FleetChange, entry: PairJournalEntry): void {
    const daemonId = this.deps.pairing.pairedDaemon()
    const harness = change.event?.harness
    if (!daemonId || !harness || this.focused(change.machineId, harness.agentId)) return
    this.deps.voice.say({
      id: `fail:${change.machineId}:${entry.epoch}:${entry.seq}`, mood: 'fail', actions: [{ key: 'g', label: 'open', choice: 'open' }], ttlMs: DISPLAY_MS,
      line: `[g] ${failLine(daemonId, { who: this.who({ local: change.local, machine: change.machine, harness }), reason: entry.text ?? '' })}`,
      about: { machineId: change.machineId, agentId: harness.agentId },
    })
  }

  /**
   * A rule, or the pair driving a harness it started, did something: reported afterwards. A key's is not.
   * One another machine asked for (`remote`) is listed in daemon_state `acted`, not spoken.
   */
  private actedEntry(change: FleetChange, entry: PairJournalEntry): void {
    if (entry.by !== 'rule' && entry.by !== 'pair' && entry.by !== 'remote') return
    const who = change.local ? entry.name : `${entry.name}@${change.machine}`
    this.acted = [{ machineId: change.machineId, machine: change.machine, agentId: entry.agentId, name: who, by: entry.by, action: entry.action ?? '', text: entry.text ?? '', at: entry.at },
      ...this.acted].slice(0, RECENT_MAX)
    if (entry.by === 'remote') { this.scheduleState(); return }
    this.deps.voice.say({
      id: `auto:${change.machineId}:${entry.epoch}:${entry.seq}`, mood: 'auto', actions: [], ttlMs: DISPLAY_MS,
      line: autoLine({ who, by: entry.by, text: entry.text ?? entry.action ?? 'acted' }),
      about: { machineId: change.machineId, agentId: entry.agentId },
    })
  }

  // ── one key ───────────────────────────────────────────────────────────────────────────────────────

  /**
   * A change to what the daemon may do (pair/gate.ts), said whatever the voice's limits: a request for the
   * person's yes (its keys, its detail), a change that took effect, or a request that went away.
   */
  onGate(event: GateEvent): void {
    const about = { machineId: this.deps.fleet.machines().find((m) => m.local)?.machineId ?? '', agentId: '' }
    if (event.type === 'asked') {
      const r = event.request
      this.deps.voice.say({ id: r.id, about, mood: 'ask', from: 'daemon', line: r.line, actions: r.actions, ttlMs: DISPLAY_MS,
        detail: r.detail, confirm: { kind: r.kind, nonce: r.nonce } }, { always: true })
    } else if (event.type === 'dropped') {
      this.deps.voice.unsay(event.request.id, event.reason)
    } else {
      this.deps.voice.say({ id: `set:${event.kind}:${this.deps.now()}:${++this.setSeq}`, about, mood: 'say', from: 'daemon', line: event.line, actions: [], ttlMs: DISPLAY_MS }, { always: true })
    }
    this.scheduleState(true)
  }

  /**
   * `daemon_confirm { requestId, kind, nonce, accept }`: the person's answer to a setting, from a window
   * attached here that was shown the request at least ARM_MS ago. Always replies (`daemon_confirm_result`).
   */
  onConfirm(connId: string, payload: Record<string, unknown>, send: (frame: Record<string, unknown>) => void): void {
    const requestId = str(payload.requestId, 120)
    const kind = str(payload.kind, 20)
    const nonce = str(payload.nonce, 64)
    const reply = (fields: Record<string, unknown>): void => { send({ type: 'daemon_confirm_result', payload: { requestId, kind, nonce, ...fields } }) }
    if (!this.clients.has(connId)) { reply({ ok: false, error: 'UI_ONLY' }); return }
    const gate = this.deps.gate
    if (!gate) { reply({ ok: false, error: 'UNSUPPORTED' }); return }
    const id = `confirm:${kind}:${nonce}`
    const shown = this.deps.shown ? this.deps.shown.check(connId, id) : 'NOT_SHOWN'
    if (shown) { reply({ ok: false, error: shown }); return }
    const result = gate.confirm(kind, nonce, payload.accept !== false)
    reply(result.ok ? { ok: true, accepted: payload.accept !== false } : { ok: false, error: result.error, ...(result.detail ? { detail: result.detail } : {}) })
  }

  /**
   * `daemon_talk { requestId, text }`: the person's words to their daemon, from a window attached here —
   * never a tool, never the pair harness itself (it has no window) — six a minute, sixty an hour, each a
   * model turn the person pays for (`cost` in every answer). Always replies (`daemon_talk_result`).
   */
  async onTalk(connId: string, payload: Record<string, unknown>, send: (frame: Record<string, unknown>) => void): Promise<void> {
    const requestId = str(payload.requestId, 120)
    const reply = (fields: Record<string, unknown>): void => { send({ type: 'daemon_talk_result', payload: { requestId, ...fields, cost: TALK_COST_NOTE } }) }
    if (!this.clients.has(connId)) { reply({ ok: false, error: 'UI_ONLY', detail: 'Talk to your daemon from a window.' }); return }
    const text = str(payload.text, 8_000).trim()
    if (!text) { reply({ ok: false, error: 'EMPTY' }); return }
    if (!this.deps.talk) { reply({ ok: false, error: 'UNSUPPORTED' }); return }
    if (!this.talkLimit.take(connId)) {
      reply({ ok: false, error: 'RATE_LIMITED', detail: 'Six talks a minute, sixty an hour.', retryAfterMs: this.talkLimit.retryAfter(connId) })
      return
    }
    const uid = str(payload.companionUid, 64)
    const result = await (uid ? this.deps.talk(text, uid) : this.deps.talk(text)).catch((err): Record<string, unknown> => ({ ok: false, error: 'FAILED', detail: err instanceof Error ? err.message.slice(0, 200) : undefined }))
    reply(result)
  }

  /** A local window opens its companion's DSH terminal, including engine setup. */
  async onOpen(connId: string, payload: Record<string, unknown>, send: (frame: Record<string, unknown>) => void): Promise<void> {
    const requestId = str(payload.requestId, 120)
    const reply = (fields: Record<string, unknown>): void => { send({ type: 'daemon_open_result', payload: { requestId, ...fields } }) }
    if (!this.clients.has(connId)) { reply({ ok: false, error: 'UI_ONLY' }); return }
    if (!this.deps.open) { reply({ ok: false, error: 'UNSUPPORTED' }); return }
    const uid = str(payload.companionUid, 64)
    if (!uid) { reply({ ok: false, error: 'STALE_COMPANION' }); return }
    const engine = payload.engine
    if (engine !== undefined && engine !== 'claude' && engine !== 'codex' && engine !== 'opencode') { reply({ ok: false, error: 'BAD_ENGINE' }); return }
    const result = await this.deps.open(uid, engine).catch((err): Record<string, unknown> => ({ ok: false, error: 'FAILED', detail: err instanceof Error ? err.message.slice(0, 200) : undefined }))
    reply(result)
  }

  /** `daemon_shown { id }`: this window has drawn that line (its keys, and its detail in full). */
  onShown(connId: string, payload: Record<string, unknown>): void {
    const id = str(payload.id, 200)
    if (id && this.clients.has(connId)) this.deps.shown?.shown(connId, id)
  }

  /** A review capability is offered only to the verified window that requested it. */
  async reviewLesson(connId: string, id: string): Promise<Record<string, unknown>> {
    if (!this.active || !this.clients.has(connId)) return { ok: false, error: 'UI_ONLY' }
    const verdict = await this.deps.lessonKey?.(connId).catch(() => ({ ok: false as const, error: 'UNVERIFIED' }))
    if (!verdict?.ok) return { ok: false, error: verdict?.error ?? 'PERSON_ONLY' }
    const result = this.deps.lessonReview?.(id) ?? { ok: false, error: 'UNSUPPORTED' }
    if (result.ok && typeof result.reviewId === 'string') this.deps.shown?.offer([result.reviewId], [connId])
    return result
  }

  /**
   * A key from a window (`daemon_act` over the daemon's socket): it counts only from a window attached here
   * (never a tool), that received this line and acknowledged it as displayed at least ARM_MS ago. A lesson's
   * key must also be the person's (`lessonKey`). Then `onAct`, which checks the line is still live and the
   * question on it is still the one on screen — for a lesson, that the id is the live line's one-time nonce.
   */
  async onKey(connId: string, payload: Record<string, unknown>, send: (frame: Record<string, unknown>) => void): Promise<void> {
    const requestId = str(payload.requestId, 120)
    const id = str(payload.id, 200)
    const refuse = (error: string, detail: string): void => { send({ type: 'daemon_act_result', payload: { requestId, id, ok: false, error, detail } }) }
    if (!this.clients.has(connId)) { refuse('UI_ONLY', 'A key counts only from a window attached to this daemon.'); return }
    const shown = this.deps.shown ? this.deps.shown.check(connId, id) : 'NOT_SHOWN'
    if (shown === 'NOT_SHOWN') { refuse('NOT_SHOWN', 'That line was never shown on this window (daemon_shown).'); return }
    if (shown === 'TOO_SOON') { refuse('TOO_SOON', 'A key counts a moment after its line is shown.'); return }
    if (id.startsWith('lesson:')) {
      const verdict = this.deps.lessonKey
        ? await this.deps.lessonKey(connId).catch(() => ({ ok: false as const, error: 'UNVERIFIED', detail: 'The daemon could not tell who pressed it.' }))
        : { ok: false as const, error: 'PERSON_ONLY', detail: 'This daemon cannot tell who pressed it: approve it at a terminal.' }
      if (!verdict.ok) { refuse(verdict.error, verdict.detail); return }
    }
    await this.onAct(payload, send, { connId })
  }

  /**
   * `daemon_act { requestId, id, choice }`: the person pressed a key on a line. Answered on the machine
   * that owns the harness, and only while the line is showing and the question on it is STILL the one the
   * line was about — a key pressed a moment late must not land on the next dialog. Always replies.
   */
  async onAct(payload: Record<string, unknown>, send: (frame: Record<string, unknown>) => void, origin: { connId: string } | null = null): Promise<void> {
    const requestId = str(payload.requestId, 120)
    const id = str(payload.id, 200)
    const choice = str(payload.choice, 200)
    const reply = (fields: Record<string, unknown>): void => {
      send({ type: 'daemon_act_result', payload: { requestId, id, ...fields } })
    }
    if (!this.active) { reply({ ok: false, error: 'PAIR_OFF' }); return }
    const proposals = this.deps.proposals
    if (proposals?.owns(id)) {
      const result = await proposals.act(id, choice).catch((err): Record<string, unknown> => ({ ok: false, error: err instanceof Error ? err.message.slice(0, 60) : 'FAILED' }))
      reply({ ok: result.ok === true, ...(typeof result.error === 'string' ? { error: result.error } : {}), ...(typeof result.detail === 'string' ? { detail: result.detail } : {}),
        ...(Array.isArray(result.results) ? { results: result.results } : {}),
        // A lesson's answer (pair/learn/propose.ts): what was learned or skipped, or its text for [s].
        ...(typeof result.learned === 'string' ? { learned: result.learned } : {}),
        ...(typeof result.skipped === 'string' ? { skipped: result.skipped } : {}),
        ...(typeof result.lesson === 'string' ? { lesson: result.lesson } : {}) })
      this.scheduleState()
      return
    }
    const say = this.deps.voice.get(id)
    if (!say || !say.about.requestId) { reply({ ok: false, error: 'GONE' }); return }
    const action: DaemonAction | undefined = say.actions.find((a) => a.choice === choice || a.key === choice)
    if (!action) { reply({ ok: false, error: 'NOT_OFFERED' }); return }
    // [g] opens the pane; that is the client's to do. Nothing is answered.
    if (action.key === 'g') { reply({ ok: true, open: { machineId: say.about.machineId, agentId: say.about.agentId } }); return }
    if (this.autonomy() === 'watch') { reply({ ok: false, error: 'AUTONOMY_WATCH' }); return }
    const target = this.deps.fleet.find(say.about.machineId, say.about.agentId)
    const question = target?.harness.question
    if (!target || !question || question.requestId !== say.about.requestId) {
      this.deps.voice.unsay(id, 'stale')
      reply({ ok: false, error: 'STALE_QUESTION' })
      return
    }
    // The floor, again, here: a deny-class prompt, or one that is not allow-class, is never approved
    // from a key, whatever a client sends. The owning machine checks once more.
    if (action.key === 'y' && (question.deny || !question.allow)) { reply({ ok: false, error: 'DENY_CLASS' }); return }
    // Another machine takes only an answer to an allow-class prompt from here, a few a minute, and both
    // machines journal it: a key on this computer never reaches further than that (BRAIN.md, Security).
    if (!target.local) {
      if (!question.permission || !question.allow || question.deny) { reply({ ok: false, error: 'REMOTE_ANSWERS_ONLY', detail: 'On another machine only an allow-class prompt is answered from here: open it.' }); return }
      if (!this.relayLimit.take()) { reply({ ok: false, error: 'RATE_LIMITED', detail: 'Too many answers sent to other machines: try again in a minute.' }); return }
    }
    let result: AnswerResult
    try {
      result = target.local
        ? await this.deps.answer({ agentId: target.harness.agentId, requestId: question.requestId, choice: action.choice })
        : await this.remoteAnswer(target, question.requestId, action.choice)
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message.slice(0, 60) : 'FAILED' }
    }
    if (!target.local) {
      this.deps.relayed?.({
        target: target.machineId, agentId: target.harness.agentId, name: target.harness.name, engine: target.harness.engine, requestId: question.requestId,
        text: `relayed "${action.choice}" to ${target.harness.name}@${target.machine}: ${result.ok ? 'answered' : `refused ${result.error ?? 'FAILED'}`}`,
        origin: origin?.connId ?? 'this daemon',
      })
    }
    if (result.ok) this.deps.voice.unsay(id, 'answered')
    // The dialog on screen was not the one the line was about: nothing was typed, and the line's keys
    // can never work again. The next watch of that harness says what is on screen now.
    else if (result.error === 'STALE_QUESTION') this.deps.voice.unsay(id, 'stale')
    reply({ ok: result.ok, machineId: target.machineId, ...(result.error ? { error: result.error } : {}), ...(result.detail ? { detail: result.detail } : {}) })
  }

  private async remoteAnswer(target: FleetHarness, requestId: string, choice: string): Promise<AnswerResult> {
    // No `by`: the owning machine decides who asked from how the request reached it (a remote machine).
    const result = await this.deps.fleet.request(target.machineId, 'pair_answer', {
      agentId: target.harness.agentId, requestId, expectRequestId: requestId, choice,
    })
    if (typeof result.error === 'string') return { ok: false, error: result.error, ...(typeof result.detail === 'string' ? { detail: result.detail } : {}) }
    return { ok: result.ok === true }
  }

  // ── daemon_state ──────────────────────────────────────────────────────────────────────────────────

  state(): Record<string, unknown> {
    const daemonId = this.deps.pairing.pairedDaemon()
    // The dial as it is now (a client shows it as a badge), and what waits for the person's yes.
    const requested = this.deps.gate?.requestedAutonomy()
    const dial = {
      autonomy: this.autonomy(),
      ...(requested && requested !== this.autonomy() ? { autonomyRequested: requested } : {}),
      confirms: (this.deps.gate?.requests() ?? []).map((r) => ({ id: r.id, kind: r.kind, nonce: r.nonce, line: r.line, detail: r.detail, actions: r.actions, at: r.at, ...(r.level ? { level: r.level } : {}) })),
    }
    if (!this.active || !daemonId) return { pair: null, needs: [], working: 0, failing: [], machines: [], done: { count: 0, last: [] }, asks: [], acted: [], ...dial }
    const harnesses = this.deps.fleet.harnesses()
    const needs = harnesses
      .filter((h) => h.harness.question)
      .sort((a, b) => a.harness.question!.since - b.harness.question!.since)
      .map((h) => {
        const q = h.harness.question!
        const said = this.needSays.get(`${h.machineId}\u0000${q.requestId}`)
        // Keys only while the line shows. After that the need is listed for the person to open.
        const live = said ? this.deps.voice.get(said.id) : null
        return {
          machineId: h.machineId, machine: h.machine, agentId: h.harness.agentId, name: h.harness.name, engine: h.harness.engine,
          requestId: q.requestId, question: q.text, options: q.options, deny: q.deny, allow: q.allow, since: q.since,
          // The whole dialog: what a [y] on its line would approve, for the window to show in full.
          ...(q.dialog !== undefined ? { detail: q.dialog } : {}),
          ...(live ? { id: live.id, line: live.line, actions: live.actions } : {}),
        }
      })
    return {
      pair: daemonId,
      ...(this.deps.companionHarness ? { companionHarness: this.deps.companionHarness() } : {}),
      needs,
      working: harnesses.filter((h) => h.harness.working && !h.harness.question).length,
      failing: harnesses.filter((h) => h.harness.failing).map((h) => ({
        machineId: h.machineId, machine: h.machine, agentId: h.harness.agentId, name: h.harness.name, reason: h.harness.failing,
      })),
      machines: this.deps.fleet.machines(),
      done: { count: this.doneCount, last: this.doneLast },
      asks: this.deps.proposals?.pending() ?? [],
      acted: this.acted,
      ...dial,
    }
  }

  private scheduleState(evenIdle = false): void {
    // Idle (pairing off, nobody attached): a change to the dial still reaches a window that is here.
    if (!this.active && evenIdle) { if (this.clients.size) this.sendState(true); return }
    if (this.stateTimer) return
    this.stateTimer = setTimeout(() => { this.stateTimer = null; this.sendState() }, STATE_DEBOUNCE_MS)
  }

  private sendState(force = false): void {
    const payload = this.state()
    const text = JSON.stringify(payload)
    if (!force && text === this.lastState) return
    this.lastState = text
    this.deps.sendLocal({ type: 'daemon_state', payload })
  }
}
