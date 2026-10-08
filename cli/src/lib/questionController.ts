import type { QuestionStep } from '../engines/facets/questionControl.js'
import type { QuestionControlFor, QuestionControlSession, QuestionStepFailure } from './questionControl.js'
import type { RegisteredSession } from './registry.js'
import type { AgentEngine } from '../engines/types.js'
import type { ShapedQuestion, QuestionRow, QuestionView, ReviewView, PaneView } from '../engines/facets/screen.js'
export type { ShapedQuestion, QuestionRow, QuestionView, ReviewView, PaneView, FoundDialog } from '../engines/facets/screen.js'
import { ampSelectionKeys } from '../engines/amp/askQuestion.js'
import { kiloSelectionKeys } from '../engines/kilo/askQuestion.js'
import { isApprovalDialog } from '../engines/kit/questionPane.js'
function multiSubmitKey(engine: AgentEngine): string { return engine === 'devin' ? 'Enter' : 'Tab' }
const STEP_MS = 350          // let the TUI repaint between keystrokes
const TEXT_MS = 250
const MAX_STEPS = 14         // hard bound on the drive loop (questions × keys), never spin on a stuck pane
const CAPTURE_LINES = 60

function norm(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/[.…]+$/, '').trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Shape a raw AskUserQuestion input into the device form. Port of the hosted runtime’s `commanderQuestions`
 * (websocket.ts): `key` MUST stay the value the CLI matches answers by — prompt/question first — because
 * the device echoes it back as the answers-map key.
 */
export function shapeQuestions(questions: unknown): ShapedQuestion[] {
  return (Array.isArray(questions) ? questions : []).map((raw, i) => {
    const q = (raw ?? {}) as Record<string, unknown>
    const opts = Array.isArray(q.options) ? q.options : []
    return {
      key: (q.prompt as string) || (q.question as string) || (q.id as string) || (q.header as string) || `question_${i}`,
      q: (q.prompt as string) || (q.question as string) || '',
      options: opts
        .map((o) => String((typeof o === 'string' ? o : (o as Record<string, unknown>)?.label) ?? ''))
        .filter(Boolean),
      // Three spellings because three CLIs: `allow_multiple` (the hosted runtime), `multiSelect` (claude),
      // `multi_select` (devin — read from a real `ask_user_question` call in its SQLite store).
      multi: (q.allow_multiple as boolean) ?? (q.multiSelect as boolean) ?? (q.multi_select as boolean) ?? false,
    }
  })
}

function rowKeys(engine: AgentEngine, row: QuestionRow): string[] {
  if (engine === 'amp') return ampSelectionKeys(row)
  // Kilo's rows sit side by side, so its walk is horizontal — see engines/kilo/askQuestion.ts.
  if (engine === 'kilo') return kiloSelectionKeys(row)
  // Same dialog, different engine: opencode numbers its ask dialog but not its permission prompt, so the
  // ROW says how it is reached and a per-engine rule would break one of the two.
  if (row.walk === 'right') return kiloSelectionKeys(row)
  if (row.walk === 'down') return ampSelectionKeys(row)
  return [row.number]
}

export function matchRow(rows: QuestionRow[], answer: string): QuestionRow | null {
  const a = norm(answer)
  if (!a) return null
  return rows.find((r) => norm(r.label) === a)
    ?? (a.length >= 3 ? rows.find((r) => norm(r.label).startsWith(a)) ?? rows.find((r) => a.startsWith(norm(r.label)) && norm(r.label).length >= 3) : undefined)
    ?? null
}

/**
 * Pick the answer for the question the dialog is currently showing: the entry keyed by its own text.
 *
 * `positional` also takes the next unused entry when none names it. Only for a dialog the answer's
 * requestId proves it was written for: without that proof, an answer that names no question on screen
 * belongs to one that is gone, and typing it here would answer — or approve — something nobody saw.
 *
 * The text must be the question's OWN (case, spacing and a trailing `…` aside), never a prefix either way.
 * An approval is titled `Approve <header>: <argument>` and the header is shared by every prompt of its
 * kind: a key left from an earlier prompt — `Approve Bash command` (its argument unread) — was a prefix of
 * `Approve Bash command: rm -rf ~/projects` and pressed Yes on it, and an old full title named a
 * header-only prompt the other way round. A client echoes back the key it was announced, so the whole
 * text is always there to match; one it has cut is answered through its requestId (`positional`).
 */
export function pickAnswer(
  answers: Record<string, string>,
  question: string,
  used: Set<string>,
  opts: { positional?: boolean } = {},
): { key: string; value: string } | null {
  const entries = Object.entries(answers)
  const q = norm(question)
  const byText = q ? entries.find(([k]) => norm(k) === q) : undefined
  if (byText && !used.has(byText[0])) return { key: byText[0], value: byText[1] }
  if (!opts.positional) return null
  const next = entries.find(([k]) => !used.has(k))
  return next ? { key: next[0], value: next[1] } : null
}

/**
 * The id a dialog is announced under — the SAME function the watcher names it with, so the answer's
 * requestId can be checked against the dialog on screen at the moment of typing rather than against
 * whatever the watcher last saw (it polls every 1.5s, and forgets on a reset).
 */
export function questionRequestId(sessionId: string, view: QuestionView): string {
  return `q_${hash(sessionId + fingerprintOf(view))}`
}

/** Why an answer was not keyed. Sent back to the client as `question_response_result.error`. */
export type QuestionAnswerError = 'STALE_QUESTION' | 'AGENT_NOT_FOUND' | 'ANSWER_BUSY' | 'ANSWER_FAILED'

export type QuestionAnswerResult = { ok: true } | { ok: false; error: QuestionAnswerError; detail: string }

const STALE_CHANGED: QuestionAnswerResult = { ok: false, error: 'STALE_QUESTION', detail: 'That question changed before your answer arrived.' }
const STALE_GONE: QuestionAnswerResult = { ok: false, error: 'STALE_QUESTION', detail: 'That question is no longer open.' }
const failed = (detail: string): QuestionAnswerResult => ({ ok: false, error: 'ANSWER_FAILED', detail })
const KEYS_FAILED = failed('The answer could not be typed into the agent\'s terminal.')
const STUCK = failed('The question did not take the answer.')
// Nothing was typed: the engine's worker had no room for the step, or was not there to take it.
const BUSY: QuestionAnswerResult = { ok: false, error: 'ANSWER_BUSY', detail: 'The agent could not take the answer just now. Nothing was typed. Try again.' }

export interface AskQuestionDeps {
  questionControlFor: QuestionControlFor
  readQuestion(session: RegisteredSession, capture: string): PaneView | Promise<PaneView>
  getSession: (sessionId: string) => RegisteredSession | undefined
  capture: (terminalTarget: string, historyLines?: number) => Promise<string | null>
  sendText: (terminalTarget: string, text: string) => Promise<boolean>
  sendKey: (terminalTarget: string, key: string) => Promise<boolean>
  /** Pins one backend locator for the whole multi-step dialog drive. */
  acquireControl?: (sessionId: string, opts?: { forAnswer?: boolean }) => (() => void) | null
  /** Injected for tests. */
  wait?: (ms: number) => Promise<void>
}

export interface QuestionAnswerPayload {
  /** Exact contents reviewed on the device; guarded submissions never use positional fallback. */
  expectedQuestions?: ShapedQuestion[]
  selectedLabels?: Record<string, string[]>
  freeTextKeys?: string[]
  allowPermissions?: boolean
  requestId?: string
  sessionId?: string
  agentId?: string
  answers?: Record<string, string>
}

/**
 * Owns the OUT side's pending map (requestId → session) and the IN side's pane driving. One answer at a
 * time per agent: a second `question_response` for a dialog already being driven is dropped, not queued.
 */
export class AskQuestionController {
  private pending = new Map<string, string>() // requestId → sessionId
  private driving = new Set<string>()         // sessionIds currently keying a dialog

  constructor(private readonly deps: AskQuestionDeps) {}

  /** Remember which session a mirrored question belongs to (the device may answer minutes later). */
  remember(requestId: string, sessionId: string): void {
    if (!requestId) return
    if (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value as string)
    this.pending.set(requestId, sessionId)
  }

  async answer(payload: QuestionAnswerPayload): Promise<QuestionAnswerResult> {
    const requestId = payload.requestId ?? ''
    if (payload.expectedQuestions !== undefined && (!Array.isArray(payload.expectedQuestions) ||
        payload.expectedQuestions.length < 1 || payload.expectedQuestions.length > 4 ||
        payload.expectedQuestions.some(q => !q || typeof q.key !== 'string' || !q.key ||
          typeof q.q !== 'string' || !q.q || !Array.isArray(q.options) || !q.options.length ||
          q.options.some(option => typeof option !== 'string' || !option) ||
          typeof q.multi !== 'boolean' || (q.multi && !Array.isArray(payload.selectedLabels?.[q.key]))))) {
      return failed('The reviewed question metadata is invalid.')
    }
    if (payload.freeTextKeys !== undefined && (!payload.expectedQuestions || !Array.isArray(payload.freeTextKeys) ||
        payload.freeTextKeys.some(key => typeof key !== 'string' || !payload.expectedQuestions!.some(q =>
          q.key === key && q.canText === true && !q.multi)))) {
      return failed('The reviewed text answer metadata is invalid.')
    }
    const remembered = this.pending.get(requestId)
    const sessionId = payload.sessionId || payload.agentId || remembered || ''
    const answers = payload.answers && typeof payload.answers === 'object' ? structuredClone(payload.answers) : null
    if (!sessionId || !answers || Object.keys(answers).length === 0) {
      console.warn(`[question] ignoring answer with no session/answers (req=${requestId})`)
      return failed('The answer named no agent or carried no choice.')
    }
    const session = this.deps.getSession(sessionId)
    const terminalTarget = session?.agentId || session?.sessionId
    if (!terminalTarget) {
      console.warn(`[question] no terminal target for ${sessionId.slice(0, 8)} — answer dropped`)
      return { ok: false, error: 'AGENT_NOT_FOUND', detail: 'That harness is no longer running.' }
    }
    if (remembered) {
      const owner = this.deps.getSession(remembered)
      if ((owner?.agentId || owner?.sessionId) !== terminalTarget) return STALE_CHANGED
    }
    if (this.driving.has(terminalTarget)) {
      console.warn(`[question] ${sessionId.slice(0, 8)} answer dropped · already driving this dialog`)
      return { ok: false, error: 'ANSWER_BUSY', detail: 'Another answer is already being entered for this harness.' }
    }
    // `forAnswer`: a dialog is the engine waiting for input mid-turn, so the open turn must not block it.
    const release = this.deps.acquireControl?.(terminalTarget, { forAnswer: true })
    // Silence here is the failure mode this whole file exists to prevent: the device sends an answer,
    // nothing keys it in, and the pane sits on the dialog looking like a hung agent.
    if (this.deps.acquireControl && !release) {
      console.warn(`[question] ${sessionId.slice(0, 8)} answer dropped · terminal control unavailable`)
      return { ok: false, error: 'ANSWER_BUSY', detail: 'The agent\'s terminal is busy. Try again.' }
    }
    // The ids the watcher could have announced this dialog under: the session it was remembered for, and
    // the session as the registry knows it now.
    const owners = [...new Set([remembered, session?.sessionId].filter((id): id is string => !!id))]
    this.driving.add(terminalTarget)
    try {
      // Inside the protected region: the lease is held from here, and a control port or a reviewed snapshot
      // that throws must still release it rather than leave the terminal busy with nothing typed.
      let native: QuestionControlSession | undefined, reviewed: QuestionAnswerPayload | undefined
      try {
        native = session ? this.deps.questionControlFor(session) : undefined
        reviewed = payload.expectedQuestions ? structuredClone(payload) : undefined
      } catch (error) {
        console.warn(`[question] ${sessionId.slice(0, 8)} answer dropped · ${(error as Error).message}`)
        return failed('The answer could not be prepared. Nothing was typed.')
      }
      const result = await this.drive(terminalTarget, answers, this.deps.getSession(sessionId)?.engine ?? 'claude', payload.allowPermissions !== false, { requestId, owners }, reviewed, native)
      this.pending.delete(requestId)
      const outcome = result.ok ? 'submitted' : result.error === 'STALE_QUESTION' ? 'refused · STALE_QUESTION, nothing typed' : 'FAILED'
      console.log(`[question] ${sessionId.slice(0, 8)} answered from device · ${outcome} (req=${requestId || 'none'})`)
      return result
    } finally {
      this.driving.delete(terminalTarget)
      release?.()
    }
  }

  /**
   * Key the answers into the pane's dialog, question by question, ending on the review screen.
   *
   * Nothing is typed until the dialog on screen is shown to be the question the answer was written for:
   * its requestId when the answer carries one, else its own text. An answer can arrive late — the agent
   * moved on, another client answered, the next question of the form is up — and positionally matching
   * it to whatever is showing now is how a person's "Yes" lands on a permission prompt they never saw.
   */
  private async drive(
    terminalTarget: string,
    answers: Record<string, string>,
    engine: AgentEngine,
    allowPermissions: boolean,
    asked: { requestId: string; owners: string[] },
    reviewed?: QuestionAnswerPayload,
    native?: QuestionControlSession,
  ): Promise<QuestionAnswerResult> {
    const wait = this.deps.wait ?? sleep
    // 'uncertain': a key had gone to the terminal before the engine's worker failed. The pane decides on the next
    // read (the dialog gone: the answer went in); nothing is typed again, since the port stays bound to that worker.
    const apply = async (step: QuestionStep): Promise<'done' | 'failed' | QuestionStepFailure> => {
      if (!native) return await this.applyLegacyStep(terminalTarget, engine, step, wait) ? 'done' : 'failed'
      if (await native.apply(step).catch(() => false)) return 'done'
      return native.failure?.() ?? 'failed'
    }
    const notEntered = (outcome: Awaited<ReturnType<typeof apply>>): QuestionAnswerResult | null =>
      outcome === 'refused' ? BUSY : outcome === 'failed' ? KEYS_FAILED : null
    let submitUncertain = false
    const used = new Set<string>()
    const reviewedComplete = () => !reviewed || used.size === reviewed.expectedQuestions!.length
    let lastQuestion = ''
    let repeats = 0
    let blanks = 0
    let answered = 0

    const generation = questionCaptureGeneration(this.deps.getSession(terminalTarget))
    for (let step = 0; step < MAX_STEPS; step++) {
      const current = this.deps.getSession(terminalTarget)
      if (!current || generation !== questionCaptureGeneration(current)) return STALE_CHANGED
      const capture = await this.deps.capture(terminalTarget, CAPTURE_LINES)
      if (reviewed && capture === null) return failed('The question could not be read.')
      if (generation !== questionCaptureGeneration(this.deps.getSession(terminalTarget))) return STALE_CHANGED
      let view: PaneView
      try { view = await this.deps.readQuestion(current, capture ?? '') }
      catch { return failed('The question could not be read.') }
      if (generation !== questionCaptureGeneration(this.deps.getSession(terminalTarget))) return STALE_CHANGED
      if (!view) {
        // Nothing on screen: either the dialog was already gone, or the last keystroke submitted it.
        return answered > 0 && reviewedComplete() ? { ok: true } : STALE_GONE
      }
      if (!allowPermissions && view.kind === 'question' && view.permission) return failed('Permission prompts cannot be answered from here.')
      if (view.kind === 'question' && view.partial) {
        // The dialog's top is out of the pane. If we have keyed an answer it has not been taken yet;
        // give the TUI a beat. If we have not, there is nothing to match an answer against.
        if (answered === 0) { console.warn('[question] dialog scrolled out of view — cannot key an answer'); return failed('The question is scrolled out of view.') }
        if (++repeats >= 2) { console.warn('[question] dialog stuck (scrolled)'); return STUCK }
        await wait(STEP_MS)
        continue
      }
      if (view.kind === 'review') {
        // Reached by our own keys, this submits the form. Reached first, it means every question was
        // answered somewhere else — submitting would send answers this person never gave.
        if (answered === 0) return STALE_GONE
        if (!reviewedComplete()) return STALE_CHANGED
        if (submitUncertain) return failed('The answers could not be submitted.')
        const outcome = await apply({ kind: 'review', key: view.submitRow })
        if (outcome === 'done') return { ok: true }
        if (outcome === 'refused') return BUSY
        if (outcome === 'failed') return failed('The answers could not be submitted.')
        // Read the pane once more: the review gone is the form submitted.
        submitUncertain = true
        await wait(STEP_MS)
        continue
      }
      // Mid-repaint the question line can read blank for a capture (see parseQuestionPane). Neither its id
      // nor its text can be checked against a blank, so look again rather than judge the dialog by it.
      if (!view.question) {
        if (++blanks > 2) return answered > 0 && reviewedComplete() ? { ok: true } : failed('The question could not be read.')
        await wait(STEP_MS)
        continue
      }
      blanks = 0
      // The same question still showing after we acted on it: give the TUI one more beat to repaint,
      // then treat it as stuck rather than hammering the pane with more keystrokes. Never consume a
      // second answer for it.
      if (view.question === lastQuestion) {
        if (++repeats >= 2) { console.warn(`[question] dialog stuck on "${view.question.slice(0, 60)}"`); return STUCK }
        await wait(STEP_MS)
        continue
      }
      repeats = 0
      lastQuestion = view.question

      // Is this the question the answer was for? Only the FIRST one needs the id: every later screen is
      // one our own keys advanced to, and must be named by its text (below).
      let positional = false
      if (answered === 0 && asked.requestId) {
        if (!asked.owners.some((owner) => questionRequestId(owner, view) === asked.requestId)) {
          console.warn(`[question] answer for req=${asked.requestId} arrived after the dialog changed to "${view.question.slice(0, 60)}" — nothing typed`)
          return STALE_CHANGED
        }
        positional = true
      }

      // Out of answers with the dialog still up = a multi-QUESTION dialog whose next question the device
      // hasn't been shown yet. Leave it open: the watcher pushes that one and the device answers it next.
      const expected = reviewed?.expectedQuestions?.find(q => q.q === view.question)
      if (reviewed && (!expected || expected.multi !== view.multi ||
          JSON.stringify(expected.options) !== JSON.stringify(view.rows.map(row => row.label)))) {
        // A request id proves the initial dialog; every reviewed screen must also match its full choices.
        return answered > 0 && reviewedComplete() ? { ok: true } : STALE_CHANGED
      }
      const picked = expected
        ? (!used.has(expected.key) && typeof answers[expected.key] === 'string'
          ? { key: expected.key, value: answers[expected.key] } : null)
        : pickAnswer(answers, view.question, used, { positional })
      if (!picked) {
        if (answered > 0 && reviewedComplete()) return { ok: true }
        console.warn(`[question] no answer names "${view.question.slice(0, 60)}" — nothing typed`)
        return STALE_CHANGED
      }
      used.add(picked.key)
      answered++

      if (reviewed?.freeTextKeys?.includes(picked.key)) {
        // Spoken words are explicitly text, even when they happen to equal an option label.
        // A permission prompt can never acquire consent through this path.
        if (!expected?.canText || view.permission || view.multi || !view.typeRow ||
            !picked.value.trim() || Buffer.byteLength(picked.value, 'utf8') > 1200 ||
            /[\x00-\x09\x0b-\x1f\x7f]/.test(picked.value)) return failed('The text answer cannot be entered into this question.')
        const typed = notEntered(await apply({ kind: 'text', row: view.typeRow, text: picked.value }))
        if (typed) return typed
        continue
      }

      if (view.multi) {
        // Device joins the selected labels with ", " (q_done_tap).
        const labels = reviewed ? reviewed.selectedLabels?.[picked.key] ?? []
          : picked.value.split(',').map((s) => s.trim()).filter(Boolean)
        if (reviewed && (!labels.length || labels.some(label => !view.rows.some(row => row.label === label)))) return failed('That answer matches no option.')
        // Core chooses the exact approved set; the engine owns toggling and advancing its UI.
        const rows = reviewed ? view.rows.filter(row => row.checked !== labels.includes(row.label))
          : labels.map(label => matchRow(view.rows, label)).filter((row): row is QuestionRow => !!row && !row.checked)
        const freeText = !reviewed && !rows.length && view.typeRow ? { row: view.typeRow, text: picked.value } : undefined
        const toggled = notEntered(await apply({ kind: 'multiple', rows, ...(freeText ? { freeText } : {}) }))
        if (toggled) return toggled
        continue
      }

      const row = reviewed ? view.rows.find(row => row.label === picked.value) ?? null : matchRow(view.rows, picked.value)
      if (row) {
        const selected = notEntered(await apply({ kind: 'select', row, enterSubmits: view.enterSubmits }))
        if (selected) return selected
        continue
      }
      if (reviewed) return failed('That answer matches no option.')
      if (!view.typeRow) { console.warn(`[question] no option matched "${picked.value.slice(0, 40)}" and no free-text row`); return failed('That answer matches no option.') }
      const typed = notEntered(await apply({ kind: 'text', row: view.typeRow, text: picked.value }))
      if (typed) return typed
    }
    return STUCK
  }

  /** Other engines keep their existing navigation until their migration batch. */
  private async applyLegacyStep(target: string, engine: AgentEngine, step: QuestionStep, wait: (ms: number) => Promise<void>): Promise<boolean> {
    if (step.kind === 'review') return this.deps.sendKey(target, step.key)
    if (step.kind === 'select') {
      for (const key of rowKeys(engine, step.row)) {
        if (!await this.deps.sendKey(target, key)) return false
        await wait(TEXT_MS)
      }
    } else if (step.kind === 'text') {
      if (!await this.typeFreeText(target, step.row, step.text, wait)) return false
    } else {
      for (const row of step.rows) {
        if (!await this.deps.sendKey(target, row.number)) return false
        await wait(TEXT_MS)
      }
      if (step.freeText && !await this.typeFreeText(target, step.freeText.row, step.freeText.text, wait)) return false
      if (!await this.deps.sendKey(target, multiSubmitKey(engine))) return false
    }
    await wait(STEP_MS)
    return true
  }

  /** True while a dialog is being keyed — the watcher pauses so a half-driven dialog isn't re-announced. */
  isDriving(sessionId: string): boolean {
    const session = this.deps.getSession(sessionId)
    return this.driving.has(session?.agentId || session?.sessionId || sessionId)
  }

  /** Free-text answer (a voice answer is always free text): open the "Type something." row, type, Enter. */
  private async typeFreeText(terminalTarget: string, typeRow: QuestionRow, text: string, wait: (ms: number) => Promise<void>): Promise<boolean> {
    if (!await this.deps.sendKey(terminalTarget, typeRow.number)) return false
    await wait(TEXT_MS)
    if (!await this.deps.sendText(terminalTarget, text)) return false
    await wait(TEXT_MS)
    return this.deps.sendKey(terminalTarget, 'Enter')
  }
}

// ── watching a terminal for an open question ─────────────────────────────────────────────────────

export interface QuestionWatcherDeps {
  readQuestion(session: RegisteredSession, capture: string): PaneView | Promise<PaneView>
  getSession: (sessionId: string) => RegisteredSession | undefined
  capture: (terminalTarget: string, historyLines?: number) => Promise<string | null>
  /** Skip the capture entirely when no device is listening — nothing would consume the question. */
  hasDevice: () => boolean
  /** A dialog is open on screen. Fires ONCE per distinct question (until it changes or closes). */
  onQuestion: (sessionId: string, requestId: string, questions: ShapedQuestion[], detail?: { permission: boolean; dialog: string }) => void
  /**
   * An announced dialog LEFT the screen — answered somewhere else, or abandoned.
   *
   * This is the other half of `onQuestion`, and it was missing: a question answered in the app (or in the
   * pane by hand) simply stopped being on screen, the watcher forgot it, and every OTHER client went on
   * showing it. On the dial that is a screen you cannot leave without dismissing a question that no longer
   * exists. The pane is the only source of truth here — there is no server-side question object — so
   * "gone from the pane" is the only signal there is.
   */
  onQuestionGone?: (sessionId: string, requestId: string) => void

  /** True while that session's dialog is being keyed by an answer already in flight. */
  isDriving?: (sessionId: string) => boolean
}

const POLL_MS = 1500
/** How long the pane read before a prompt stands for the turn it starts: past this, that turn's own start
 *  is read instead (a prompt that never became a turn). Turns were seen to start 8 s after their prompt
 *  under load. */
const PROMPT_BASELINE_MS = 120_000
// Consecutive empty polls before a question is declared gone.
//
// NOT 1. A capture taken mid-repaint parses as no-dialog, and announcing a close on that would yank a
// live question off the dial's screen — the exact failure this feature exists to prevent, inverted.
// Two ticks costs 1.5s of delay on a real close and makes a flicker unable to cause one.
const GONE_TICKS = 2

// Amp and codex are here for their PERMISSION prompt, not a question tool — neither has one. That prompt
// is drawn only in the pane and recorded nowhere, so polling the pane is the only way it is ever seen.
// Codex needs no parser of its own: it draws numbered rows under a `Press enter to confirm or esc to
// cancel` footer, which is the shared parser's anchor exactly (`__fixtures__/permission-codex.txt`), and
// the question it lands on is the command itself. Membership in this set is what starts the poll, so an
// engine belongs here only once something can actually read its pane.
const QUESTION_ENGINES = new Set<AgentEngine>(['claude', 'commandcode', 'codex', 'cursor', 'devin', 'hermes', 'opencode', 'muse', 'amp', 'kilo', 'grok', 'agy', 'copilot'])

/** Does this engine ever paint a question dialog? Callers use it to decide whether to watch its pane. */
export function pollsQuestions(engine: AgentEngine): boolean {
  return QUESTION_ENGINES.has(engine)
}

/**
 * The OUT half. The obvious source — the transcript's AskUserQuestion `tool_use` line — is useless here:
 * the CLI does not flush that line until the question has been ANSWERED (its JSONL `timestamp` is the
 * message's creation time, not its write time), so a device would only ever learn about a question after
 * it no longer exists. The dialog itself, on the other hand, is on screen the whole time it is waiting.
 *
 * So while a turn is open we read the pane. This also means the question survives an adapter restart and
 * re-announces to a device that attaches mid-question — neither of which a one-shot event could do.
 */
export class QuestionWatcher {
  private readonly watching = new Set<string>()
  private timer: NodeJS.Timeout | undefined
  private readonly pendingPolls = new Map<string, { cancelled: boolean }>()
  private readonly pendingBaselines = new Map<string, { cancelled: boolean }>()
  private last = new Map<string, string>() // sessionId → fingerprint of the announced question
  private lastId = new Map<string, string>()  // sessionId → requestId of the announced question
  private misses = new Map<string, number>()  // sessionId → consecutive polls with no dialog
  private readonly blocked = new Map<string, string>()
  /** sessionId → the dialog that was ALREADY on the pane when this turn began. */
  private readonly preTurn = new Map<string, string>()
  /** sessionId → the pane as the daemon read it right before typing a prompt: its dialog, if any, and when. */
  private readonly beforePrompt = new Map<string, { fingerprint: string | null; at: number }>()


  constructor(private readonly deps: QuestionWatcherDeps) {}

  /**
   * A turn just began — remember any dialog already on the pane, so it is not
   * announced as this turn's question.
   *
   * A dialog belonging to a turn cannot have been on screen before that turn's
   * first byte. That invariant is the only way to tell "waiting for an answer"
   * from "answered a moment ago and still drawn", because a pane looks
   * identical either way.
   *
   * MEASURED: the daemon attached to a Codex that had just been asked about an
   * update and answered in the app. Its first capture, 0.8s into the NEXT turn,
   * still held that prompt — so the dial was shown a question nobody was being
   * asked, and it stood there for 25s until the engine's output scrolled it out
   * of the captured window.
   *
   * Deliberately NOT applied on attach: re-announcing a genuinely open dialog to
   * a client that arrives mid-question is a feature, and there is no turn
   * boundary there to reason from.
   */
  noteTurnStart(sessionId: string): void {
    this.preTurn.delete(sessionId)
    this.cancelPending(sessionId)
    // The daemon typed this turn's prompt, and read the pane as it did: what was on it then is the turns
    // before's, and nothing drawn since is (notePrompt says why).
    const typed = this.beforePrompt.get(sessionId)
    this.beforePrompt.delete(sessionId)
    if (typed && Date.now() - typed.at <= PROMPT_BASELINE_MS) {
      if (typed.fingerprint) this.preTurn.set(sessionId, typed.fingerprint)
      return
    }
    const pending = { cancelled: false }
    this.pendingBaselines.set(sessionId, pending)
    void (async () => {
      try {
        const session = this.deps.getSession(sessionId)
        const target = session?.agentId || session?.sessionId
        if (!target || session?.active === false || (session?.engine && !pollsQuestions(session.engine))) return
        const generation = questionCaptureGeneration(session)
        const capture = await this.deps.capture(target, CAPTURE_LINES)
        if (pending.cancelled || generation !== questionCaptureGeneration(this.deps.getSession(sessionId))) return
        const view = await this.deps.readQuestion(session!, capture ?? '')
        if (pending.cancelled || generation !== questionCaptureGeneration(this.deps.getSession(sessionId))) return
        if (!view || view.kind !== 'question' || !view.question || view.rows.length === 0) return
        // Only if nothing has been announced for this turn yet: the capture takes
        // a moment, and a dialog that opened inside that window is this turn's.
        if (this.lastId.has(sessionId)) return
        this.preTurn.set(sessionId, fingerprintOf(view))
      } catch {
        // A failed read supplies no baseline. Keep watching for a fresh dialog.
      } finally {
        if (this.pendingBaselines.get(sessionId) === pending) this.pendingBaselines.delete(sessionId)
      }
    })()
  }

  /**
   * The daemon is typing a prompt, and `capture` is the pane as it read it right before (core/input.ts
   * messageWriter): the honest "before this turn" for the turn that prompt starts.
   *
   * A capture taken when the turn is SEEN to start can be too late for that. The turn is seen to start
   * from the transcript, after the prompt is confirmed typed, and an engine can draw its question before
   * that: measured in the soak run (e2e/endurance.e2e.ts) under load, Codex took the prompt at 20:42:54.9
   * (its prompt hook), drew its question a moment later, and the turn was seen to start at 20:43:02.2, 7 s
   * on. The capture at that start held the turn's own question, recorded it as the turns before's, and it
   * was never announced: the agent waited on a question no window or device was shown.
   *
   * A read that failed supplies nothing: the turn's start reads the pane itself, as before.
   */
  notePrompt(sessionId: string, capture: string | null, view: PaneView): void {
    const session = this.deps.getSession(sessionId)
    if (capture === null || !session || (session.engine && !pollsQuestions(session.engine))) return
    const dialog = view && view.kind === 'question' && view.question && view.rows.length > 0 ? fingerprintOf(view) : null
    this.beforePrompt.set(sessionId, { fingerprint: dialog, at: Date.now() })
  }

  /** Poll this session's pane while its turn is open (called on turn_started). */
  start(sessionId: string): void {
    if (this.watching.has(sessionId)) return
    const session = this.deps.getSession(sessionId)
    // Only the engines that actually paint a question dialog: Claude and Command Code share one shape,
    // devin has its own (parseDevinQuestionPane). Polling any other pane would be pure waste.
    if (!session || session.active === false || !(session.agentId || session.sessionId) || !QUESTION_ENGINES.has(session.engine)) return
    this.watching.add(sessionId)
    // One clock also starts the reads in one event-loop turn, allowing the tmux
    // backend to batch them without delaying polls or caching terminal content.
    this.timer ??= setInterval(() => {
      for (const id of this.watching) void this.tick(id)
    }, POLL_MS)
  }

  /**
   * Stop polling — and CLOSE any question still outstanding on this session.
   *
   * ⚠️ THIS IS THE COMMON CASE, NOT THE EDGE ONE, and leaving it out made the whole close mechanism look
   * like it did not work. `stop()` is called on turn_ended, and answering the question is precisely what
   * lets the turn end — so the dialog leaving the pane and the watcher being torn down happen within a
   * second or two of each other, far inside the two-tick confirmation. Measured on hardware: the answer
   * landed at ~16:50:19 and the turn ended at 16:50:29 with no close ever announced.
   *
   * No confirmation is needed here and none is wanted: the turn is over, so whatever we announced is
   * definitively not waiting for anybody any more. The same holds for the other callers — an agent that
   * was removed cannot answer either.
   */
  stop(sessionId: string): void {
    this.cancelPending(sessionId)
    this.preTurn.delete(sessionId)
    this.blocked.delete(sessionId)
    this.watching.delete(sessionId)
    if (!this.watching.size && this.timer) { clearInterval(this.timer); this.timer = undefined }
    const requestId = this.lastId.get(sessionId)
    this.forget(sessionId)
    if (requestId) this.deps.onQuestionGone?.(sessionId, requestId)
  }


  stopAll(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.watching.clear()
    for (const pending of this.pendingPolls.values()) pending.cancelled = true
    for (const pending of this.pendingBaselines.values()) pending.cancelled = true
    this.preTurn.clear()
    this.beforePrompt.clear()
    this.blocked.clear()
    this.last.clear()
    this.lastId.clear()
    this.misses.clear()
  }

  /** A device (re)joined: forget what we announced so an open question is pushed again. */
  reset(): void {
    this.last.clear()
    this.lastId.clear()
    this.misses.clear()
  }

  private forget(sessionId: string): void {
    this.last.delete(sessionId)
    this.lastId.delete(sessionId)
    this.misses.delete(sessionId)
  }

  private cancelPending(sessionId: string): void {
    const poll = this.pendingPolls.get(sessionId)
    if (poll) poll.cancelled = true
    const baseline = this.pendingBaselines.get(sessionId)
    if (baseline) baseline.cancelled = true
  }

  /**
   * A poll found no dialog. Announce the close once the miss is CONFIRMED, and only if we announced the
   * question in the first place — a session nobody was told about has nothing to take back.
   */
  private noteGone(sessionId: string): void {
    this.last.delete(sessionId)   // unchanged: a dialog that comes back announces fresh
    const requestId = this.lastId.get(sessionId)
    if (!requestId) return
    const misses = (this.misses.get(sessionId) ?? 0) + 1
    this.misses.set(sessionId, misses)
    if (misses < GONE_TICKS) return
    this.lastId.delete(sessionId)
    this.misses.delete(sessionId)
    this.deps.onQuestionGone?.(sessionId, requestId)
  }


  private async tick(sessionId: string): Promise<void> {
    // A capture can take longer than POLL_MS. Keep one outstanding poll per
    // session, including a cancelled capture that has not returned yet.
    if (this.pendingPolls.has(sessionId)) return
    const session = this.deps.getSession(sessionId)
    const terminalTarget = session?.agentId || session?.sessionId
    if (!terminalTarget || session?.active === false || (session?.engine && !pollsQuestions(session.engine))) { this.stop(sessionId); return }
    // Both of these silently do nothing, which is how a live dialog can sit on the terminal with no trace
    // in the log. Say it once per transition rather than every 1.5s tick.
    const blocked = !this.deps.hasDevice() ? 'no device' : this.deps.isDriving?.(sessionId) ? 'driving an answer' : ''
    if (blocked !== (this.blocked.get(sessionId) ?? '')) {
      this.blocked.set(sessionId, blocked)
      console.log(`[question] ${sessionId.slice(0, 8)} watcher ${blocked ? `paused · ${blocked}` : 'polling'}`)
    }
    if (blocked) return
    const pending = { cancelled: false }
    this.pendingPolls.set(sessionId, pending)
    const generation = questionCaptureGeneration(session)
    let capture: string | null
    let view: PaneView = null
    try {
      capture = await this.deps.capture(terminalTarget, CAPTURE_LINES)
      if (capture !== null) view = await this.deps.readQuestion(session!, capture)
    } catch {
      capture = null
    } finally {
      if (this.pendingPolls.get(sessionId) === pending) this.pendingPolls.delete(sessionId)
    }
    if (pending.cancelled || generation !== questionCaptureGeneration(this.deps.getSession(sessionId))
      || !this.deps.hasDevice() || this.deps.isDriving?.(sessionId)) return
    if (capture === null) {
      // Unavailable is not an empty pane, and breaks a run of confirmed misses.
      this.misses.delete(sessionId)
      return
    }
    if (view?.kind === 'question' && view.partial) {
      // Scrolled so its top is out of the pane: still open, so the client showing it keeps showing it —
      // but there is no question text to announce, and the rows in view are whichever the scroll left.
      this.misses.delete(sessionId)
      return
    }
    if (!view || view.kind !== 'question' || !view.question || view.rows.length === 0) {
      // Dialog closed, or moved to review. Either way it is no longer waiting on anybody, so the clients
      // showing it are told to stop — see noteGone for why this is not announced on the first miss.
      this.noteGone(sessionId)
      return
    }
    this.misses.delete(sessionId)   // a dialog on screen ends any run of misses
    const fingerprint = fingerprintOf(view)
    // Already on the pane before this turn started → it belongs to whatever came
    // before, and has been answered. Say nothing until it changes or leaves.
    if (this.preTurn.get(sessionId) === fingerprint) return
    this.preTurn.delete(sessionId)
    if (this.last.get(sessionId) === fingerprint) return
    this.last.set(sessionId, fingerprint)

    // A pane-derived question has no tool_use id. The key only has to round-trip through the device and
    // back (the answer is keyed into the pane, not matched to a tool call), so the question's own text
    // serves as both — and the device dedups a repeated push by this id. The answer brings the id back,
    // and AskQuestionController recomputes it off the live pane before typing: a different id there
    // means a different dialog, and the answer is refused (STALE_QUESTION) instead of keyed into it.
    const requestId = questionRequestId(sessionId, view)
    this.lastId.set(sessionId, requestId)
    const baseline = this.pendingBaselines.get(sessionId)
    if (baseline) baseline.cancelled = true
    this.deps.onQuestion(sessionId, requestId, [{
      key: view.question,
      q: view.question,
      options: view.rows.map((r) => r.label),
      multi: view.multi,
      ...(view.typeRow && !view.multi && !view.permission ? { canText: true } : {}),
    }], { permission: isApprovalDialog(view), dialog: view.dialog ?? view.question })

  }
}

/** Snapshot scalar values before awaiting I/O: registry records can change in
 * place when an engine exits, moves, or is replaced in the same pane. */
function questionCaptureGeneration(session: RegisteredSession | undefined): string {
  return session ? JSON.stringify([session.agentId, session.sessionId, session.engine, session.active,
    session.tmuxPane, session.primaryRuntimeKey, session.runtimes, session.processIdentity]) : ''
}

/**
 * What makes two captures the SAME dialog: its words, its options, its arity — and, when the parser kept
 * the whole dialog, what it says below its first line (a command that differs only on its second line is
 * another prompt).
 *
 * ⚠️ NOT the raw `dialog`. The id is recomputed every 1.5s poll and again at the moment an answer is typed,
 * so it may only change when the QUESTION does. The raw dialog changes on its own: Hermes and Muse paint a
 * live timer inside it (`(01m30s · ↓ 82 tok)`, `(21s · esc to interrupt)`), and every engine moves its
 * `❯`/`›`/`>` cursor and ticks its `[✔]` boxes in place. Hashed raw, a question was re-announced as new on
 * every poll — the needs-you alert, the sound, the dial push, again and again — and every answer from a
 * dial, a device or the cable was refused as STALE_QUESTION. `dialogSignature` is the dialog with all of
 * that taken out; the raw text still goes, unchanged, to the pair's floor (isApprovalDialog, pair/sensor).
 */
function fingerprintOf(view: QuestionView): string {
  const base = `${view.question}|${view.rows.map((r) => r.label).join('|')}|${view.multi}`
  return view.dialog === undefined ? base : `${base}|${dialogSignature(view.dialog)}`
}

// A live status group: an elapsed time (`21s`, `30.5s`, `01m30s`, `1h02m`), a token counter (`↓ 82 tok`,
// `1.2k tokens`) or `esc to interrupt` inside one pair of parentheses. Units hug their digits, as every
// engine paints them, so `(see 2 files)` or `(tokens.json)` is never mistaken for one.
const TIMER_GROUP = String.raw`\([^()\n]*?(?:\b\d+(?:\.\d+)?(?:ms|s|m|h)\b|\b\d+m\d+s\b|\b\d+h\d+m\b|\d+(?:\.\d+)?k?\s*tok(?:en)?s?\b|esc to interrupt)[^()\n]*\)`
const TIMER_GROUP_RE = new RegExp(TIMER_GROUP, 'i')
const TIMER_GROUPS_RE = new RegExp(TIMER_GROUP, 'gi')
// The same, outside parentheses: `↓ 82 tokens · esc to interrupt`.
const STATUS_BITS_RE = /[↑↓]\s*\d+(?:\.\d+)?k?\s*tok(?:en)?s?\b|\besc to interrupt\b/i
// A bare elapsed time, with no parentheses and no ` · ` to mark it: a status line that is only a word or
// three and a duration — a verb in -ing/-ed (`waiting 3s`, `thinking 4s`, `Churned for 4s`) or anything
// trailing off in an ellipsis (`Waiting… 12s`, `Fetch Bitcoin price… 1m33s`). A command's own number stays:
// `sleep 30s` and `retry after 30s` are neither.
const DURATION = String.raw`(?:\d+h\d+m(?:\d+s)?|\d+m\d+s|\d+(?:\.\d+)?m?s)`
const WORDS = String.raw`(?:\p{L}[\p{L}'’-]*\s+){0,2}\p{L}[\p{L}'’-]*`
const BARE_TIMER_LINE_RE = new RegExp(String.raw`^${WORDS}(?:(?<=ing|ed)(?:\s+for)?\s+|\s*(?:…|\.{3})\s*)${DURATION}$`, 'iu')
// …and one hung off the end of a longer line, after an ellipsis or a column gap: grok's right-aligned
// `Waiting on answers for Which color should I report?             4.2s`. Only the time goes.
const TRAILING_TIMER_RE = new RegExp(String.raw`(?:(?<=…|\.{3})\s*|\s{2,})${DURATION}$`, 'u')
// Codex's cursor readout under its request_user_input rows: `option 2/4 | tab to add notes`.
const CURSOR_READOUT_RE = /^option\s+\d+\s*\/\s*\d+\b/i
// Whatever leads a line and moves on its own: a cursor (`❯ › > ▶`), a spinner frame (braille, `✻`, `◐`,
// Muse's `◇`/`◆`) or a box/tab state (`☐ ☒ ✔ ○ ● ◉`).
const LEAD_MARKS_RE = /^(?:[❯›>▶►▸➤\u2800-\u28ff✻✽✶✳✢✺✹✸✷◐◓◑◒◴◵◶◷◇◆☐☑☒✔✓✗✘○◯●◉◎]\s*)+/u
// A row's own state right after its number, or at the start of an unnumbered row: `[ ]`, `[✔]`, `(•)`, `◉`.
const ROW_STATE_RE = /^(\d+[.)]\s+|)(?:\[[^\]\n]?\]|\([^)\n]?\)|[☐☑☒✔✓○◯●◉◎])\s*/u
// Box drawing: frames and rules redraw to the pane's width.
const BOX_RE = /[\u2500-\u257f]+/g

/**
 * The dialog as a person reads it, with nothing that changes while it waits: status lines (a live timer,
 * bare or in parentheses, a token counter, `esc to interrupt`) and Codex's cursor readout dropped; cursor marks, spinner frames
 * and checkbox/radio state stripped; frames and whitespace collapsed. Every word of the prompt stays —
 * two commands that differ anywhere are still two signatures.
 */
function dialogSignature(dialog: string): string {
  const out: string[] = []
  for (const raw of dialog.replace(/\u00a0/g, ' ').split('\n')) {
    let line = raw.replace(BOX_RE, ' ').trim()
    if (CURSOR_READOUT_RE.test(line)) continue
    line = line.replace(LEAD_MARKS_RE, '')
    const row = /^\d+[.)]\s/.test(line)
    // A line that carries a live timer is the engine's status line (Hermes' `💻 curl … (01m30s · ↓ 82 tok)`
    // under its frame, Muse's `◇ Calling tools (21s · esc to interrupt)` above its rule, a bare `waiting 3s`),
    // not the prompt: the prompt is always painted on lines of its own. A ROW keeps its words; only the
    // group goes.
    if (!row && (TIMER_GROUP_RE.test(line) || STATUS_BITS_RE.test(line) || BARE_TIMER_LINE_RE.test(line))) continue
    if (!row) line = line.replace(TRAILING_TIMER_RE, '')
    line = line.replace(TIMER_GROUPS_RE, ' ').replace(ROW_STATE_RE, '$1').replace(/\s+/g, ' ').trim()
    if (line) out.push(line)
  }
  return out.join('\n')
}

function hash(value: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}
