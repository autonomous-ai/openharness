/**
 * PROPOSE, and the person's answer (daemons/LEARNING.md). The paired daemon's learner, in every harnessd:
 * it keeps the signals this machine noticed, distills them while nothing is working (or after an hour
 * regardless), and when you are at this computer says ONE line for a pending lesson:
 *
 *   [y/n/s] teach your agents "run-migrations-safely"? you corrected codex.
 *   [y/n/s] teach your agents "deploy-api"? borrowed from hermes.
 *
 *   y  approve: the lesson moves to skills/ (or notes/) with one commit, is published (publish.ts) and
 *      exported where the person asked (export.ts), the daemon is credited (`learned` in the journal, and
 *      `zoo.lesson` bond when signed in), and it says so.
 *   n  skip: gone, and its hash and signal are remembered so it is never proposed again.
 *   s  show: the lesson's text in a `daemon_brief` frame, with [y/n] still working for a minute.
 *
 * When it may speak: at most ONE lesson proposal an hour; never while a `need` line is showing; never
 * about the pane you are looking at; never at autonomy `watch`; only while you are here. An unanswered
 * proposal stays in daemon_state `asks` for ten minutes and comes back after a day. Nothing is taught
 * without the person (approval.ts): a key on the line, whose id carries a one-time nonce only windows and
 * `hn` are sent, or `harness pair lessons approve <id>` at a terminal outside every harness.
 *
 * L2 rides the same tick: borrowing (borrow.ts, opt-in) adds candidates to the same queue of proposals, the
 * curator (curate.ts) marks and archives what goes unused, and export (export.ts, opt-in) follows every change.
 */
import type { Autonomy } from '../floor.js'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { IntelligenceStatus } from '../intelligence.js'
import { DISPLAY_MS, keysPrefix } from '../voice.js'
import { DIALOG_MAX, statusText, str, type DaemonAction, type DaemonMood, type DaemonSay } from '../protocol.js'
import { lessonLineId } from './approval.js'
import { BORROW_EVERY_MS, type BorrowPass } from './borrow.js'
import type { CuratorPass } from './curate.js'
import type { Distilled } from './distill.js'
import type { ExportStep } from './export.js'
import { findProject, publishNote, unpublishNote, withdrawSkill } from './publish.js'
import { NO_GIT_NOTE, type LessonRecord, type LessonStore } from './store.js'
import { contentHash, type Signal } from './types.js'
import type { LessonUsage } from './usage.js'

export const LESSON_PROPOSAL_GAP_MS = 60 * 60_000
export const LESSON_REPROPOSE_MS = 24 * 60 * 60_000
export const LESSON_ASK_TTL_MS = 10 * 60_000
export const LESSON_SHOW_KEYS_MS = 60_000
export const DISTILL_EVERY_MS = 10 * 60_000
export const DISTILL_BATCH = 3
export const SIGNAL_QUEUE_MAX = 20
export const SIGNAL_MAX_WAIT_MS = 60 * 60_000

type Result = Record<string, unknown>
const fail = (error: string, detail?: string): Result => ({ ok: false, error, ...(detail ? { detail } : {}) })

const TEACH: DaemonAction = { key: 'y', label: 'teach', choice: 'y' }
const SKIP: DaemonAction = { key: 'n', label: 'skip', choice: 'n' }
const SHOW: DaemonAction = { key: 's', label: 'show', choice: 's' }
const PERSON = 'asks you at a terminal outside Harness, or press [y] on the daemon\'s line'

export interface LearnerDeps {
  store: LessonStore
  distiller: { distill: (signal: Signal) => Promise<Distilled> }
  intelligence?: () => IntelligenceStatus
  /** One durable review queue per collection; null until its DSH is opened. */
  queueFile?: () => string | null
  history?: { status: () => Record<string, unknown> | null; start: (hours: unknown) => Result; cancel: () => Result; tick: () => Promise<void> }
  pairedDaemon: () => string | null
  autonomy: () => Autonomy
  voice: { say: (say: DaemonSay) => boolean; unsay: (id: string, reason: string) => boolean; showing: (mood: DaemonMood) => boolean }
  /** Loopback only (backendSocket.sendLocal). */
  sendLocal: (frame: Record<string, unknown>) => void
  /** A person is at this computer and the brain is thinking. */
  present: () => boolean
  /** The person is looking at this harness (on this machine) right now. */
  focused: (agentId: string) => boolean
  /** Something on this machine is working: distilling waits for a quiet moment. */
  busy?: () => boolean
  /** The folders harnesses run in: a note's project is found among them by its hash. */
  projects: () => string[]
  /** Whether the person opted this project in to notes in its AGENTS.md (pair.jsonc `learn.agentsMd`). */
  agentsMd?: (projectDir: string) => boolean
  /** The zoo's credit: a journal entry `learned` with the daemon's id (pair/sensor.ts learned). */
  learned?: (entry: { daemon: string; lesson: LessonRecord }) => void
  /** Bond for the daemon that found the lesson: `zoo.lesson` (lib/zooLessons.ts), signed in only. */
  credit?: (daemonId: string, lesson: LessonRecord) => void
  /** L2, borrow: pair.jsonc `learn.borrow` and the reader (borrow.ts). */
  borrowEnabled?: () => boolean
  borrower?: { pass: (learnedBy: string) => BorrowPass }
  /** L2, check: when lessons were used (usage.ts) and the daily curator (curate.ts). */
  usage?: LessonUsage
  curator?: { maybeRun: () => CuratorPass | null }
  /** L2, export: pair.jsonc `learn.export` and the writer (export.ts). */
  exportTo?: () => string[]
  exporter?: { sync: (opts?: { dryRun?: boolean }) => { steps: ExportStep[]; dryRun: boolean }; active: () => boolean }
  machineId: () => string
  /** daemon_state `asks` changed. */
  changed?: () => void
  /** This computer's home folder, shown as `~`. */
  home?: string | null
  now: () => number
  log?: (line: string) => void
}

interface Live { id: string; lessonId: string; at: number; until: number }

export class PairLearner {
  private queue: Signal[] = []
  private queuePath: string | null | undefined
  private lastReview: { at: number; outcome: string } | null = null
  private live: Live | null = null
  private lastDistill = -Infinity
  private lastBorrow = -Infinity
  private exportKey: string | null = null
  private ticking = false
  private seq = 0
  private readonly reviews = new Map<string, { lessonId: string; textHash: string; until: number; scope: string | null | undefined }>()

  constructor(private readonly deps: LearnerDeps) {}

  // ── notice → distill ──────────────────────────────────────────────────────────────────────────────

  /** A signal this machine noticed (signals.ts). Kept until a quiet moment; nothing happens at once. */
  signal(signal: Signal): void {
    if (!this.deps.pairedDaemon()) return
    this.loadQueue()
    if (this.deps.queueFile && !this.queuePath) return
    if (this.queue.some((s) => s.key === signal.key)) return
    this.queue.push(signal)
    if (this.queue.length > SIGNAL_QUEUE_MAX) this.queue.shift()
    this.saveQueue()
    this.deps.changed?.()
  }

  get queued(): number { this.loadQueue(); return this.queue.length }

  status(): Record<string, unknown> {
    this.loadQueue()
    return { ...(this.deps.intelligence?.() ?? {}), queued: this.queue.length,
      pending: this.deps.store.pending().length, reviewing: this.ticking, lastReview: this.lastReview,
      ...(this.deps.history ? { history: this.deps.history.status() } : {}) }
  }

  private loadQueue(): void {
    if (!this.deps.queueFile) return
    const path = this.deps.queueFile()
    if (path === this.queuePath) return
    this.queuePath = path
    this.queue = []; this.lastReview = null; this.lastDistill = -Infinity
    if (!path) return
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { v?: number; queue?: unknown; lastReview?: { at?: unknown; outcome?: unknown } }
      if (raw.v !== 1 || !Array.isArray(raw.queue)) return
      this.queue = raw.queue.filter((s): s is Signal => !!s && typeof s === 'object' &&
        ['correction', 'repeat-failure', 'repeat-steps'].includes(s.kind) && typeof s.key === 'string' &&
        typeof s.at === 'number' && Array.isArray(s.from) && s.from.every((f: unknown) => !!f && typeof f === 'object') &&
        Array.isArray(s.evidence) && s.evidence.every((e: unknown) => typeof e === 'string') &&
        (!s.steps || (Array.isArray(s.steps) && s.steps.every((e: unknown) => typeof e === 'string')))).slice(-SIGNAL_QUEUE_MAX)
      if (typeof raw.lastReview?.at === 'number' && typeof raw.lastReview.outcome === 'string') {
        this.lastReview = { at: raw.lastReview.at, outcome: raw.lastReview.outcome }
      }
    } catch { /* First review, or unreadable local state. */ }
  }

  private saveQueue(): void {
    if (!this.queuePath) return
    try {
      mkdirSync(dirname(this.queuePath), { recursive: true, mode: 0o700 })
      const tmp = `${this.queuePath}.tmp`
      writeFileSync(tmp, JSON.stringify({ v: 1, queue: this.queue, lastReview: this.lastReview }), { mode: 0o600 })
      renameSync(tmp, this.queuePath)
    } catch { this.deps.log?.('[learn] could not persist the review queue') }
  }

  /** Distill, borrow, maybe propose, curate, export. Called on a timer; safe to call any time. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      if (this.deps.history) await this.deps.history.tick()
      await this.distillBatch()
      this.borrow()
      this.propose()
      this.curate()
      this.exportWhenChanged()
    } finally {
      this.ticking = false
    }
  }

  private async distillBatch(): Promise<void> {
    this.loadQueue()
    const daemon = this.deps.pairedDaemon()
    const now = this.deps.now()
    if (!daemon || !this.queue.length || now - this.lastDistill < DISTILL_EVERY_MS) return
    if (this.deps.intelligence && this.deps.intelligence().state !== 'ready') return
    const waited = now - this.queue[0]!.at
    if (this.deps.busy?.() && waited < SIGNAL_MAX_WAIT_MS) return
    this.lastDistill = now
    const path = this.queuePath
    for (const signal of this.queue.slice(0, DISTILL_BATCH)) {
      const result = await this.deps.distiller.distill(signal).catch((): Distilled => ({ lesson: null, why: 'failed' }))
      if (!this.deps.pairedDaemon() || (this.deps.queueFile && path !== this.deps.queueFile()) ||
        (this.deps.intelligence && this.deps.intelligence().state !== 'ready')) return
      const retry = !result.lesson && ['timeout', 'failed', 'no-model', 'cap', 'usage-limit'].includes(result.why)
      this.queue = this.queue.filter(s => s.key !== signal.key)
      // Keep failures, but don't let one troublesome observation starve the rest.
      if (retry) this.queue.push(signal)
      if (!result.lesson) {
        this.lastReview = { at: this.deps.now(), outcome: result.why }
        this.deps.log?.(`[learn] ${signal.kind} · nothing (${result.why}${result.refusal ? `: ${result.refusal}` : ''})`)
      } else {
        const added = this.deps.store.add({ lesson: result.lesson, signal, learnedBy: daemon, source: result.source })
        this.lastReview = { at: this.deps.now(), outcome: added.ok ? 'pending' : added.error }
        this.deps.log?.(`[learn] ${signal.kind} · ${added.ok ? `pending ${added.record.id} "${added.record.name}"` : added.error}`)
      }
      this.saveQueue()
      this.deps.changed?.()
      if (retry) break
    }
  }

  /** L2 borrow: every few hours, when quiet, a few new candidates from the other engines' own stores. */
  private borrow(): void {
    const daemon = this.deps.pairedDaemon()
    const now = this.deps.now()
    if (!daemon || !this.deps.borrower || this.deps.borrowEnabled?.() !== true) return
    if (now - this.lastBorrow < BORROW_EVERY_MS || this.deps.busy?.()) return
    this.lastBorrow = now
    try {
      const pass = this.deps.borrower.pass(daemon)
      if (pass.added.length) this.deps.log?.(`[learn] borrowed ${pass.added.length} of ${pass.considered}`)
    } catch (err) {
      this.deps.log?.(`[learn] borrow failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** L2 check: the daily curator, while pairing is on. */
  private curate(): void {
    if (!this.deps.pairedDaemon() || !this.deps.curator) return
    try { this.deps.curator.maybeRun() } catch (err) {
      this.deps.log?.(`[learn] curator failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** L2 export: when pair.jsonc's destinations change (or at start), bring the engines' folders in line. */
  private exportWhenChanged(): void {
    const key = JSON.stringify(this.deps.exportTo?.() ?? [])
    if (key === this.exportKey) return
    this.exportKey = key
    this.exportSync()
  }

  private exportSync(): ExportStep[] {
    const exporter = this.deps.exporter
    if (!exporter || !exporter.active()) return []
    try {
      const { steps } = exporter.sync()
      const moved = steps.filter((s) => s.action !== 'keep')
      if (moved.length) this.deps.log?.(`[learn] export · ${moved.map((s) => `${s.action} ${s.dest}/${s.name}${s.why ? ` (${s.why})` : ''}`).join(', ')}`)
      return steps
    } catch (err) {
      this.deps.log?.(`[learn] export failed: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  }

  // ── propose ───────────────────────────────────────────────────────────────────────────────────────

  /** Say one line for a pending lesson, if every rule allows it now. True when it went out. */
  propose(): boolean {
    const now = this.deps.now()
    const daemon = this.deps.pairedDaemon()
    if (!daemon || this.deps.autonomy() === 'watch' || !this.deps.present()) return false
    if (this.current()) return false
    const last = this.deps.store.lastProposedAt()
    if (last !== null && now - last < LESSON_PROPOSAL_GAP_MS) return false
    if (this.deps.voice.showing('need')) return false
    const lesson = this.deps.store.pending().find((r) => {
      const at = this.deps.store.proposedAt(r.id)
      return (at === null || now - at >= LESSON_REPROPOSE_MS) && !r.from.some((f) => f.agentId && this.deps.focused(f.agentId))
    })
    if (!lesson) return false
    // The line's id carries a one-time nonce: only windows and `hn` are ever sent it (approval.ts).
    const id = lessonLineId(lesson.id)
    // What [y] would teach, in full (daemons/BRAIN.md, "Security"): the window shows it before it
    // acknowledges the line (`daemon_shown`), and a key counts only after that.
    const said = this.deps.voice.say({
      id, about: { machineId: this.deps.machineId(), agentId: lesson.from[0]?.agentId ?? '' }, mood: 'ask',
      line: this.line(lesson), actions: [TEACH, SKIP, SHOW], ttlMs: DISPLAY_MS, detail: this.detail(lesson),
    })
    if (!said) return false
    this.deps.store.markProposed(lesson.id, now)
    this.live = { id, lessonId: lesson.id, at: now, until: now + LESSON_ASK_TTL_MS }
    this.deps.changed?.()
    return true
  }

  /** `[y/n/s] teach your agents "name"? you corrected codex.` */
  line(lesson: LessonRecord): string {
    const engines = [...new Set(lesson.from.map((f) => f.engine))]
    const who = engines.length > 1 ? `${engines.slice(0, -1).join(', ')} and ${engines[engines.length - 1]}` : engines[0] ?? 'an agent'
    const where = lesson.projectName ?? 'this project'
    const why = lesson.signal.kind === 'correction' ? `you corrected ${who}.`
      : lesson.signal.kind === 'repeat-failure' ? `${who} hit the same failure.`
        : lesson.signal.kind === 'borrowed' ? `borrowed from ${who}.`
          : lesson.signal.kind === 'conversation' ? 'from your recent conversations.'
          : `the same steps, ${new Set(lesson.from.map((f) => `${f.agentId}:${f.session}:${f.turn}`)).size} times in ${where}.`
    const what = lesson.kind === 'skill' ? `teach your agents "${lesson.name}"?` : `add a note for ${where}?`
    return statusText(`${keysPrefix([TEACH, SKIP, SHOW])}${what} ${why}`, 140)
  }

  private current(): Live | null {
    if (this.live && this.deps.now() >= this.live.until) this.live = null
    if (this.live && !this.deps.store.pending().some((r) => r.id === this.live!.lessonId)) this.live = null
    return this.live
  }

  // ── the brain's proposals interface ───────────────────────────────────────────────────────────────

  owns(id: string): boolean { return id.startsWith('lesson:') }

  /** A deliberate viewer review. Its capability goes only to the requesting, verified window. */
  review(id: string): Result {
    if (!this.deps.pairedDaemon()) return fail('PAIR_OFF')
    const lesson = this.deps.store.pending().find(r => r.id === id)
    if (!lesson) return fail('NOT_PENDING')
    for (const [key, row] of this.reviews) if (row.until <= this.deps.now()) this.reviews.delete(key)
    if (this.reviews.size >= 30) this.reviews.delete(this.reviews.keys().next().value!)
    const reviewId = lessonLineId(id)
    this.reviews.set(reviewId, { lessonId: id, textHash: contentHash(this.deps.store.text(lesson)), until: this.deps.now() + LESSON_ASK_TTL_MS, scope: this.deps.queueFile?.() })
    return { ok: true, reviewId, lesson: this.summary(lesson), text: this.deps.store.text(lesson), expiresInMs: LESSON_ASK_TTL_MS }
  }

  cancelReviews(): void { this.reviews.clear() }

  /** For daemon_state `asks`: the one lesson waiting for a key, while it waits, its text in full. */
  pending(): Array<{ id: string; line: string; actions: DaemonAction[]; detail: string }> {
    const live = this.current()
    const lesson = live ? this.deps.store.pending().find((r) => r.id === live.lessonId) : null
    return live && lesson ? [{ id: live.id, line: this.line(lesson), actions: [TEACH, SKIP, SHOW], detail: this.detail(lesson) }] : []
  }

  /** A lesson's whole text, as approving it would write it, bounded like a dialog. */
  private detail(lesson: LessonRecord): string {
    const text = this.deps.store.text(lesson)
    return text.length > DIALOG_MAX ? `${text.slice(0, DIALOG_MAX)}\n… (cut: harness pair lessons show ${lesson.id})` : text
  }

  /** A key on the line (daemon_act): y teach, n skip, s show. Always answers. The id is the nonce. */
  async act(id: string, choice: string): Promise<Result> {
    const reviewed = this.reviews.get(id)
    if (reviewed) {
      const record = this.deps.store.pending().find(r => r.id === reviewed.lessonId)
      if (reviewed.until <= this.deps.now() || !this.deps.pairedDaemon() || reviewed.scope !== this.deps.queueFile?.() ||
        !record || contentHash(this.deps.store.text(record)) !== reviewed.textHash) {
        this.reviews.delete(id); return fail('GONE')
      }
      if (!['y', 'n'].includes(choice)) return fail('NOT_OFFERED')
      this.reviews.delete(id)
      // An explicit person action, like CLI approval, is independent of unsolicited suggestion autonomy.
      return choice === 'y' ? this.approve(reviewed.lessonId, 'key') : this.skip(reviewed.lessonId)
    }
    const live = this.current()
    if (!live || live.id !== id) return fail('GONE')
    const key = [TEACH, SKIP, SHOW].find((a) => a.key === choice || a.choice === choice || a.label === choice)?.key
    if (!key) return fail('NOT_OFFERED')
    if (key === 's') return this.show(live)
    if (key === 'y' && this.deps.autonomy() === 'watch') return fail('AUTONOMY_WATCH')
    this.live = null
    this.deps.voice.unsay(id, key === 'y' ? 'answered' : 'declined')
    this.deps.changed?.()
    return key === 'y' ? this.approve(live.lessonId, 'key') : this.skip(live.lessonId)
  }

  private show(live: Live): Result {
    const lesson = this.deps.store.pending().find((r) => r.id === live.lessonId)
    if (!lesson) return fail('GONE')
    const text = this.deps.store.text(lesson)
    // The keys keep working while the person reads it.
    live.until = Math.max(live.until, this.deps.now() + LESSON_SHOW_KEYS_MS)
    const keys = [TEACH, SKIP]
    this.deps.sendLocal({ type: 'daemon_brief', payload: {
      desk: 'local', line: statusText(`lesson "${lesson.name}", pending`, 140),
      items: [{ id: live.id, kind: 'lesson', machineId: this.deps.machineId(), line: statusText(`${keysPrefix(keys)}${this.line(lesson).replace(/^\[[a-z/]+\]\s*/, '')}`, 140), actions: keys, text }],
    } })
    return { ok: true, shown: true, lesson: text }
  }

  // ── what a key and the CLI both do ────────────────────────────────────────────────────────────────

  /**
   * Approve a pending lesson (or, for an approved note, publish it again — `create` makes an AGENTS.md when
   * the project is opted in and has none, because the person asked for exactly that). Credits the daemon.
   */
  approve(id: string, by: 'key' | 'cli', opts: { create?: boolean } = {}): Result {
    const already = this.deps.store.approved().find((r) => r.id === id)
    let record: LessonRecord
    let commit: string | null = null
    let note: string | undefined
    if (already) {
      if (already.kind !== 'note') return fail('NOT_PENDING', `lesson ${id} is approved`)
      record = already
    } else {
      const approved = this.deps.store.approve(id, by)
      if (!approved.ok) return approved
      record = approved.record
      commit = approved.commit
      note = approved.note
      this.deps.learned?.({ daemon: record.learnedBy, lesson: record })
      this.deps.credit?.(record.learnedBy, record)
      this.deps.usage?.changed()
      if (this.live?.lessonId === id) { this.deps.voice.unsay(this.live.id, 'answered'); this.live = null; this.deps.changed?.() }
    }
    const published = this.publish(record, opts)
    const exported = record.kind === 'skill' ? this.exportSync() : []
    const where = record.projectName ?? 'the project'
    const said = record.kind === 'skill' ? `learned "${record.name}". harness sessions on every engine will load it.`
      : published.ok ? `noted in ${where}'s ${published.untracked ? '.harness/lessons.md' : String(published.file).split('/').pop()}.`
        : published.error === 'NO_INSTRUCTION_FILE' ? `kept "${record.name}". ${where} has no AGENTS.md: harness pair lessons approve ${record.id} --create writes one.`
          : `kept "${record.name}". it could not be written for ${where}: ${String(published.detail ?? published.error)}`
    if (by === 'key' || this.deps.present()) {
      this.deps.voice.say({ id: `learned:${record.id}:${++this.seq}`, about: { machineId: this.deps.machineId(), agentId: '' }, mood: 'say', line: statusText(said, 140), actions: [], ttlMs: DISPLAY_MS })
    }
    return {
      ok: true, id: record.id, learned: record.name, kind: record.kind, commit, line: said,
      published: record.kind === 'skill' ? { via: 'runtime', dir: this.tilde(this.deps.store.skillsDir) } : published,
      ...(exported.some((s) => s.action === 'write' || s.action === 'update') ? { exported: this.exportSummary(exported) } : {}),
      ...(note ? { note } : {}),
    }
  }

  private publish(record: LessonRecord, opts: { create?: boolean }): Result {
    if (record.kind !== 'note') return { ok: true, via: 'runtime' }
    const project = findProject(record.project, this.deps.projects())
    if (!project) return fail('PROJECT_UNKNOWN', 'no harness here runs in that project now; approve it again from one that does')
    const agentsMd = this.deps.agentsMd?.(project) === true
    if (opts.create && !agentsMd) return fail('NOT_OPTED_IN', 'notes go in AGENTS.md only for a project in pair.jsonc "learn": { "agentsMd": [...] }')
    const result = publishNote(project, record, { agentsMd, create: opts.create })
    return result.ok ? { ok: true, file: this.tilde(result.file), ...(result.created ? { created: true } : {}), ...(result.untracked ? { untracked: true } : {}) } : { ...result }
  }

  skip(id: string): Result {
    const skipped = this.deps.store.skip(id)
    if (!skipped.ok) return skipped
    if (this.live?.lessonId === id) { this.deps.voice.unsay(this.live.id, 'declined'); this.live = null; this.deps.changed?.() }
    return { ok: true, id, skipped: skipped.record.name }
  }

  /** `git revert` of the lesson's commit, and unpublished: its note taken out, its skill out of runtimes and exports. */
  revert(id: string): Result {
    const reverted = this.deps.store.revert(id)
    if (!reverted.ok) return reverted
    let unpublished: Result = { via: 'runtime' }
    if (reverted.record.kind === 'note') {
      const project = findProject(reverted.record.project, this.deps.projects())
      const result = project ? unpublishNote(project, id) : { ok: true as const, file: null }
      unpublished = result.ok ? { file: result.file ? this.tilde(result.file) : null } : { ...result }
    } else unpublished = { via: 'runtime', withdrawn: this.withdrawn(reverted.record) }
    return { ok: true, id, reverted: reverted.record.name, commit: reverted.commit, unpublished, ...(reverted.note ? { note: reverted.note } : {}) }
  }

  /**
   * A skill that left skills/ (reverted, archived): out of the copies in running sessions, and out of the
   * engine folders it was exported to. Answers how many session copies went.
   */
  withdrawn(record: LessonRecord): number {
    this.deps.usage?.changed()
    if (record.kind !== 'skill') return 0
    const removed = withdrawSkill(record.name, this.deps.projects())
    this.exportSync()
    return removed.length
  }

  /** An archived skill back in skills/ (one commit), its unused clock started again, exported again. */
  restore(id: string): Result {
    const restored = this.deps.store.restore(id)
    if (!restored.ok) return restored
    this.deps.usage?.restored(id)
    this.deps.usage?.changed()
    this.exportSync()
    return { ok: true, id, restored: restored.record.name, commit: restored.commit, ...(restored.note ? { note: restored.note } : {}) }
  }

  private exportSummary(steps: ExportStep[]): Result[] {
    return steps.map((s) => ({ dest: s.dest, name: s.name, action: s.action, path: this.tilde(s.path), ...(s.why ? { why: s.why } : {}) }))
  }

  // ── `harness pair lessons [list|show|approve|skip|revert|restore|export]` ─────────────────────────

  /**
   * The verbs. `approve`, `restore` and `export` (not a dry run) need `confirmed`, which only the control
   * interface sets — after the person's one-time nonce checked out (pair/control.ts, approval.ts).
   */
  async local(payload: Record<string, unknown>): Promise<Result> {
    const action = str(payload.action, 20) || 'list'
    const id = str(payload.id, 40)
    const store = this.deps.store
    if (action === 'review_recent') return this.deps.history?.start(payload.hours ?? 24) ?? fail('UNSUPPORTED')
    if (action === 'cancel_review') return this.deps.history?.cancel() ?? fail('UNSUPPORTED')
    if (action === 'list') {
      return {
        ok: true, root: this.tilde(store.root), git: store.git, ...(store.git ? {} : { note: NO_GIT_NOTE }),
        lessons: store.list().map((r) => this.summary(r)),
        learning: this.status(),
      }
    }
    if (action === 'export') {
      if (!this.deps.exporter) return fail('UNSUPPORTED')
      if (payload.dryRun !== true && payload.confirmed !== true) return fail('CONFIRM', `export ${PERSON}`)
      const { steps, dryRun } = payload.dryRun === true ? this.deps.exporter.sync({ dryRun: true }) : { steps: this.exportSync(), dryRun: false }
      return { ok: true, dryRun, destinations: this.deps.exportTo?.() ?? [], steps: this.exportSummary(steps) }
    }
    if (!id) return fail('MISSING_ID', `lessons ${action} needs a lesson id (harness pair lessons list)`)
    switch (action) {
      case 'show': {
        const record = store.get(id)
        return record ? { ok: true, lesson: this.summary(record), text: store.text(record) } : fail('NOT_FOUND', `no lesson ${id}`)
      }
      case 'approve':
        // The control interface sets this after the person's nonce; a caller that only claims it never gets here.
        if (payload.confirmed !== true) return fail('CONFIRM', `approve ${PERSON}`)
        return this.approve(id, 'cli', { create: payload.create === true })
      case 'restore':
        if (payload.confirmed !== true) return fail('CONFIRM', `restore ${PERSON}`)
        return this.restore(id)
      case 'skip': return this.skip(id)
      case 'revert': return this.revert(id)
      default: return fail('UNKNOWN_ACTION', `lessons has no "${action}" (list, show, approve, skip, revert, restore, export)`)
    }
  }

  private summary(r: LessonRecord): Result {
    const usage = this.deps.usage
    const entry = usage?.entry(r.id) ?? null
    return {
      id: r.id, kind: r.kind, name: r.name, status: r.status, description: r.description, learnedBy: r.learnedBy,
      signal: r.signal.kind, project: r.projectName, source: r.source, created: new Date(r.created).toISOString(),
      reason: r.reason ?? null, evidence: r.evidence,
      sources: r.from.map(f => ({ engine: f.engine, machine: f.machine, agentId: f.agentId, session: f.session, turn: f.turn, at: f.at, title: f.title ?? null })),
      ...(r.provenance ? { provenance: r.provenance } : {}),
      ...(r.approved ? { approved: r.approved } : {}), ...(r.commit ? { commit: r.commit } : {}),
      ...(r.status === 'approved' && usage ? {
        lastUsed: entry?.lastUsed ? new Date(entry.lastUsed).toISOString() : null,
        unusedDays: usage.unusedDays(r),
        ...(entry?.stale ? { stale: true } : {}),
      } : {}),
      from: r.from.map((f) => (r.source === 'borrowed' ? `${f.engine}@${f.machine} ${f.session}` : `${f.engine}@${f.machine} turn ${f.turn}`)),
    }
  }

  private tilde(path: string): string {
    const home = this.deps.home?.replace(/\/+$/, '')
    return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
  }
}

/** The brain takes one set of proposals: the control interface's (`ask:`) and the learner's (`lesson:`). */
export function joinProposals(...sources: Array<{ owns: (id: string) => boolean; act: (id: string, choice: string) => Promise<Result>; pending: () => Array<{ id: string; line: string; actions: DaemonAction[] }> }>) {
  return {
    owns: (id: string): boolean => sources.some((source) => source.owns(id)),
    act: (id: string, choice: string): Promise<Result> => sources.find((source) => source.owns(id))?.act(id, choice) ?? Promise.resolve(fail('GONE')),
    pending: (): Array<{ id: string; line: string; actions: DaemonAction[] }> => sources.flatMap((source) => source.pending()),
  }
}
