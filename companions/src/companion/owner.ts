/**
 * The owning machine's half of every write (daemons/BRAIN.md, "Control interface"): the ONE place a
 * daemon acts on a harness, whoever asked — a key a person pressed on a daemon's line, the pair harness's
 * tool call, a pair.jsonc rule, or another machine's brain over a sealed `pair_*` request.
 *
 * It re-checks everything on the machine that holds the harness, because that is the only machine that
 * knows what is on the screen right now:
 *   - the floor (pair/floor.ts): never a terminal or the pair harness itself, never a deny-class approve,
 *     only the dialog's own options, a start is always mode `ask` and never bypass;
 *   - that a question is STILL the one the answer was for (`STALE_QUESTION`, nothing typed) — here from
 *     the sensor, then again by AskQuestionController against the dialog on screen as it types;
 *   - autonomy `watch`: nothing is written at all.
 * And it journals every action it takes (`act` entries: who asked, what was done).
 *
 * Reads are here too, so another machine's brain can list and read this machine's harnesses with one
 * sealed request each (`pair_list`, `pair_read`).
 */
import { isAbsolute } from 'node:path'
import type { PairSensor } from './sensor.js'
import { answerFloor, untouchableDetail, type Autonomy, type Untouchable } from './floor.js'
import { statusText, str, type PairActor, type PairHarness, type PairQuestion } from './protocol.js'
import { RateLimit } from './limit.js'

export interface OwnerSubject {
  agentId: string
  name: string
  engine: string
  /** `live` runs now; `stopped` is paused with its conversation kept (resume brings it back). */
  status: 'live' | 'stopped'
  /** Why the daemon may never drive it, if it may not. */
  untouchable: Untouchable | null
  cwd?: string | null
  dsh?: string | null
}

export type OwnerResult = { ok: true; [key: string]: unknown } | { ok: false; error: string; detail?: string }

export interface OwnerDeps {
  sensor: Pick<PairSensor, 'enabled' | 'harness' | 'acted'>
  autonomy: () => Autonomy
  subject: (agentId: string) => OwnerSubject | null
  subjects: () => OwnerSubject[]
  /** The harness's last recaps and the person's last asks (CommanderMirror). */
  recent?: (agentId: string) => { recaps: string[]; asks: string[] }
  /** AskQuestionController.answer: keys `option` only if the dialog on screen is still `requestId`. */
  keyAnswer: (input: { agentId: string; requestId: string; question: string; option: string }) =>
    Promise<{ ok: true } | { ok: false; error: string; detail?: string }>
  /** backend.onMessage: the same door the apps type through. */
  message: (agentId: string, text: string, deliveryId: string) => void
  /** backend.onCancel: stop the turn in flight. */
  cancel: (agentId: string) => void
  /** backend.onCreateAgent, always with mode `ask` and bypass off. */
  create: (input: { engine: string; cwd: string; prompt: string | null; name: string | null }) =>
    Promise<{ ok: true; agentId: string } | { ok: false; error: string; detail?: string }>
  /** The guarded stop service (`agent_delete` is Stop/Pause: the conversation is kept). */
  stop: (agentId: string) => Promise<void>
  /** backend.onResumeAgent. */
  resume: (agentId: string) => Promise<{ ok: true } | { ok: false; error: string; detail?: string }>
  newId: () => string
  now?: () => number
}

/** The sealed machine-to-machine requests this answers (lib/e2ee/applicationFrames.ts PAIR_REQUESTS). */
export const OWNER_REQUESTS = new Set(['pair_list', 'pair_read', 'pair_answer', 'pair_send', 'pair_stop', 'pair_start', 'pair_pause', 'pair_resume'])

export const PROMPT_MAX = 8_000

/** Answers one other machine's connection may have keyed here: a minute's worth, and an hour's. */
export const REMOTE_ANSWER_LIMITS = [{ windowMs: 60_000, max: 6 }, { windowMs: 60 * 60_000, max: 60 }]

/** Where a sealed request came from: the relay connection, and the label its identity was paired under. */
export interface RemoteOrigin { connId: string; label?: string | null }

export interface OwnerRow {
  agentId: string
  name: string
  engine: string
  status: 'working' | 'waiting' | 'idle' | 'failed' | 'stopped'
  question?: PairQuestion
  recap?: string
  failing?: string
  untouchable?: Untouchable
  cwd?: string
}

export class PairOwner {
  private readonly remoteAnswers: RateLimit

  constructor(private readonly deps: OwnerDeps) {
    this.remoteAnswers = new RateLimit(REMOTE_ANSWER_LIMITS, deps.now ?? Date.now)
  }

  // ── reads ────────────────────────────────────────────────────────────────────────────────────────

  list(): OwnerRow[] {
    return this.deps.subjects().map((subject) => this.row(subject, this.deps.sensor.harness(subject.agentId)))
  }

  read(agentId: string): OwnerResult {
    const subject = agentId ? this.deps.subject(agentId) : null
    if (!subject) return { ok: false, error: 'NOT_FOUND' }
    const harness = this.deps.sensor.harness(agentId)
    const recent = subject.untouchable === 'terminal' ? null : this.deps.recent?.(agentId) ?? null
    return {
      ok: true,
      // `harness` keeps the shape `pair_read` has always answered (the sensor's view, or null).
      harness,
      row: this.row(subject, harness),
      ...(recent ? { recaps: recent.recaps.map((r) => statusText(r, 600)), asks: recent.asks.map((a) => statusText(a, 300)) } : {}),
    }
  }

  private row(subject: OwnerSubject, h: PairHarness | null): OwnerRow {
    const status: OwnerRow['status'] = subject.status === 'stopped' ? 'stopped'
      : h?.question ? 'waiting' : h?.working ? 'working' : h?.failing ? 'failed' : 'idle'
    return {
      agentId: subject.agentId, name: subject.name, engine: subject.engine, status,
      ...(h?.question ? { question: h.question } : {}),
      ...(h?.recap ? { recap: h.recap } : {}),
      ...(h?.failing ? { failing: h.failing } : {}),
      ...(subject.untouchable ? { untouchable: subject.untouchable } : {}),
      ...(subject.cwd ? { cwd: subject.cwd } : {}),
    }
  }

  // ── writes ───────────────────────────────────────────────────────────────────────────────────────

  /** A live harness the daemon may drive, or why not. */
  private drivable(agentId: string): { ok: true; subject: OwnerSubject } | { ok: false; error: string; detail?: string } {
    if (!this.deps.sensor.enabled()) return { ok: false, error: 'PAIR_OFF' }
    if (this.deps.autonomy() === 'watch') return { ok: false, error: 'AUTONOMY_WATCH', detail: 'The daemon only watches: nothing is done for you.' }
    const subject = agentId ? this.deps.subject(agentId) : null
    if (!subject || subject.status !== 'live') return { ok: false, error: 'GONE', detail: 'That harness is not running here.' }
    if (subject.untouchable) return { ok: false, error: 'UNTOUCHABLE', detail: untouchableDetail(subject.untouchable) }
    return { ok: true, subject }
  }

  /**
   * `why` names what decided it (a rule), for the journal. `origin` is where a `remote` answer came from:
   * another machine may only answer an ALLOW-CLASS prompt here (its one-time yes, or its decline).
   */
  async answer(input: { agentId: string; requestId: string; choice: string }, by: PairActor, why?: string, origin?: string): Promise<OwnerResult> {
    const drivable = this.drivable(input.agentId)
    if (!drivable.ok) return drivable
    const question = this.deps.sensor.harness(input.agentId)?.question
    if (!question || !input.requestId || question.requestId !== input.requestId) {
      return { ok: false, error: 'STALE_QUESTION', detail: 'That question is no longer the one on screen.' }
    }
    if (by === 'remote' && (!question.permission || !question.allow)) {
      return { ok: false, error: 'REMOTE_ANSWERS_ONLY', detail: 'Another machine may only answer an allow-class prompt here.' }
    }
    const floor = answerFloor(question, input.choice)
    if (!floor.ok) return floor
    const keyed = await this.deps.keyAnswer({ agentId: input.agentId, requestId: question.requestId, question: question.text, option: floor.option })
    if (!keyed.ok) return keyed
    this.deps.sensor.acted(drivable.subject, {
      by, action: 'answer', requestId: question.requestId, ...(origin ? { origin } : {}),
      text: `answered "${statusText(floor.option, 60)}" to "${statusText(question.text, 120)}"${why ? ` (${statusText(why, 60)})` : ''}${origin ? ` (from ${statusText(origin, 60)})` : ''}`,
    })
    return { ok: true, option: floor.option }
  }

  send(input: { agentId: string; text: string }, by: PairActor): OwnerResult {
    const drivable = this.drivable(input.agentId)
    if (!drivable.ok) return drivable
    const text = input.text.trim()
    if (!text) return { ok: false, error: 'EMPTY' }
    if (text.length > PROMPT_MAX) return { ok: false, error: 'TOO_LONG', detail: `A prompt is at most ${PROMPT_MAX} characters.` }
    // Text typed into a pane that shows a dialog lands IN the dialog. The question comes first.
    if (this.deps.sensor.harness(input.agentId)?.question) {
      return { ok: false, error: 'QUESTION_OPEN', detail: 'That harness is waiting on a question: answer it first.' }
    }
    const deliveryId = this.deps.newId()
    this.deps.message(input.agentId, text, deliveryId)
    this.deps.sensor.acted(drivable.subject, { by, action: 'send', text: `sent "${statusText(text, 120)}"` })
    return { ok: true, deliveryId }
  }

  stop(input: { agentId: string }, by: PairActor): OwnerResult {
    const drivable = this.drivable(input.agentId)
    if (!drivable.ok) return drivable
    this.deps.cancel(input.agentId)
    this.deps.sensor.acted(drivable.subject, { by, action: 'stop', text: 'stopped the turn' })
    return { ok: true }
  }

  async start(input: { engine: string; cwd: string; prompt?: string | null; name?: string | null }, by: PairActor): Promise<OwnerResult> {
    if (!this.deps.sensor.enabled()) return { ok: false, error: 'PAIR_OFF' }
    if (this.deps.autonomy() === 'watch') return { ok: false, error: 'AUTONOMY_WATCH', detail: 'The daemon only watches: nothing is done for you.' }
    if (!input.engine || input.engine === 'terminal') return { ok: false, error: 'INVALID_ENGINE', detail: 'The daemon starts agents, never terminals.' }
    if (!input.cwd || !isAbsolute(input.cwd)) return { ok: false, error: 'INVALID_CWD', detail: 'Name an absolute folder on that machine.' }
    const prompt = input.prompt?.trim() || null
    if (prompt && prompt.length > PROMPT_MAX) return { ok: false, error: 'TOO_LONG' }
    const name = input.name ? statusText(input.name, 40) || null : null
    const created = await this.deps.create({ engine: input.engine, cwd: input.cwd, prompt, name })
    if (!created.ok) return created
    this.deps.sensor.acted({ agentId: created.agentId, name: name ?? input.engine, engine: input.engine }, {
      by, action: 'start', text: `started ${input.engine} in ${statusText(input.cwd, 120)} (mode ask)`,
    })
    return { ok: true, agentId: created.agentId }
  }

  async pause(input: { agentId: string }, by: PairActor): Promise<OwnerResult> {
    const drivable = this.drivable(input.agentId)
    if (!drivable.ok) return drivable
    try {
      await this.deps.stop(input.agentId)
    } catch (err) {
      const code = (err as { code?: unknown })?.code
      return { ok: false, error: typeof code === 'string' ? code : 'PAUSE_FAILED', detail: err instanceof Error ? err.message.slice(0, 200) : undefined }
    }
    this.deps.sensor.acted(drivable.subject, { by, action: 'pause', text: 'paused (conversation kept)' })
    return { ok: true }
  }

  async resume(input: { agentId: string }, by: PairActor): Promise<OwnerResult> {
    if (!this.deps.sensor.enabled()) return { ok: false, error: 'PAIR_OFF' }
    if (this.deps.autonomy() === 'watch') return { ok: false, error: 'AUTONOMY_WATCH', detail: 'The daemon only watches: nothing is done for you.' }
    const subject = input.agentId ? this.deps.subject(input.agentId) : null
    if (!subject) return { ok: false, error: 'GONE', detail: 'No harness by that id here.' }
    if (subject.untouchable) return { ok: false, error: 'UNTOUCHABLE', detail: untouchableDetail(subject.untouchable) }
    if (subject.status === 'live') return { ok: true, already: true }
    const resumed = await this.deps.resume(input.agentId)
    if (!resumed.ok) return resumed
    this.deps.sensor.acted(subject, { by, action: 'resume', text: 'resumed' })
    return { ok: true }
  }

  // ── another machine's brain (sealed pair_*) ───────────────────────────────────────────────────────

  /**
   * One sealed request from another machine's brain. Who asked is decided HERE, from how it arrived: a
   * `remote` request from that connection, whatever `by` it carries. Another machine may read, and may
   * answer an allow-class prompt — rate-limited per connection and journaled with where it came from —
   * and nothing else: a daemon never lets a process on one computer reach further than it already could.
   */
  async handle(type: string, payload: Record<string, unknown>, from: RemoteOrigin = { connId: 'unknown' }): Promise<Record<string, unknown>> {
    const by: PairActor = 'remote'
    const origin = from.label ? `${from.label} (${from.connId.slice(0, 12)})` : from.connId.slice(0, 40)
    const agentId = str(payload.agentId, 200)
    let result: OwnerResult
    switch (type) {
      case 'pair_list':
        if (!this.deps.sensor.enabled()) return { error: 'PAIR_OFF' }
        return { harnesses: this.list() }
      case 'pair_read':
        result = this.read(agentId)
        break
      case 'pair_answer':
        if (!this.deps.sensor.enabled()) return { error: 'PAIR_OFF' }
        if (!this.remoteAnswers.take(from.connId)) return { error: 'RATE_LIMITED', detail: 'Too many answers from that machine: try again in a minute.' }
        // `requestId` on the wire is the RPC's own correlation id; the question it answers rides as
        // `expectRequestId` (pair/brain.ts remoteAnswer).
        result = await this.answer({ agentId, requestId: str(payload.expectRequestId, 120), choice: str(payload.choice, 300) }, by, undefined, origin)
        break
      case 'pair_send': case 'pair_stop': case 'pair_start': case 'pair_pause': case 'pair_resume':
        return { error: 'REMOTE_ANSWERS_ONLY', detail: 'Another machine may only answer an allow-class prompt here; the rest is done at this machine.' }
      default:
        return { error: 'UNSUPPORTED' }
    }
    if (!result.ok) return { error: result.error, ...(result.detail ? { detail: result.detail } : {}) }
    const { ok: _ok, ...rest } = result
    return { ok: true, ...rest }
  }
}
