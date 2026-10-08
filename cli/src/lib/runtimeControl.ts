import type { ModelControlFor } from './modelControl.js'
import { RuntimeProfileControlError } from '../engines/facets/modelControl.js'
export { RuntimeProfileControlError, type RuntimeProfileErrorCode } from '../engines/facets/modelControl.js'
import type { ScreenReader } from './screenReader.js'
import { stripAnsi } from '../engines/kit/pane.js'
export type { PaneInspection, PaneTakeover } from '../engines/facets/screen.js'
import { parseRuntimeProfile } from './runtimeProfileWire.js'
import type { RegisteredSession } from './registry.js'
import { devinModelCommandResult } from '../engines/devin/runtimeProfile.js'
import { countCommandcodeRefusals } from '../engines/commandcode/runtimeProfile.js'
import { parseHermesPickerPage } from '../engines/hermes/runtimeProfile.js'
import { parsePiFooterProfile, parsePiThinkingSelection, piThinkingSteps } from '../engines/pi/runtimeProfile.js'
import {
  countOpencodePickers,
  opencodeRowMatches,
  opencodeRowNamesModel,
  parseOpencodePickerRows,
  type OpencodeModelTarget,
  type OpencodePickerRow,
} from '../engines/opencode/runtimeProfile.js'
import {
  type CursorModelTarget,
  type RuntimeProfile,
  type RuntimeProfileManager,
} from './runtimeProfile.js'

const COMMAND_CONFIRM_MS = 8_000
const PICKER_OPEN_MS = 3_000
const PICKER_STEP_MS = 2_000
/** Hard bound on ladder keystrokes — twice pi's seven levels, so a desynchronised walk still terminates. */
const PI_LADDER_MAX_STEPS = 14
/** Hermes' longest picker page is a provider's model list; twice its size still terminates. */
const HERMES_PAGE_MAX_STEPS = 60
/** "Anthropic (13 models)" names provider key `anthropic`; "GitHub Copilot (17 models)" names `copilot`. */
function hermesProviderMatches(row: string, provider: string): boolean {
  const name = row.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase()
  const key = provider.toLowerCase()
  return name === key || name.replace(/[^a-z0-9]/g, '').includes(key.replace(/[^a-z0-9]/g, ''))
}

export interface RuntimeProfileControllerDeps {
  modelControlFor: ModelControlFor
  readScreen: ScreenReader
  manager: Pick<RuntimeProfileManager, 'getState' | 'selectedModel' | 'codexCatalog' | 'modelsForSession'
    | 'beginControl' | 'finishControl' | 'cancelControl' | 'confirmEffort' | 'waitForProfile' | 'waitForModel'
    | 'devinTarget' | 'opencodeCatalog' | 'commandcodeTarget' | 'ingestConfig' | 'hermesTarget' | 'cursorTarget' | 'confirmControlProfile'> & {
      supportsControl(session: RegisteredSession): boolean | Promise<boolean>
      ingestPane(session: RegisteredSession, text: string, silent?: boolean): boolean | Promise<boolean>
    }
  getSession: (sessionId: string) => RegisteredSession | undefined
  validateRuntime: (session: RegisteredSession) => Promise<boolean>
  capture: (terminalTarget: string, historyLines?: number) => Promise<string | null>
  sendText: (terminalTarget: string, text: string) => Promise<boolean>
  /** Type without submitting. */
  sendLiteral: (terminalTarget: string, text: string) => Promise<boolean>
  sendKey: (terminalTarget: string, key: string) => Promise<boolean>
  acquireInput: (sessionId: string) => (() => void) | null
}

export interface CursorParameterRow {
  kind: 'context' | 'reasoning' | 'fast' | 'thinking'
  value: string
  selected: boolean
  cursor: boolean
  index: number
}

export function parseCursorModelPicker(capture: string): { selectedFamily: string | null } | null {
  const lines = stripAnsi(capture).split('\n')
  if (!lines.some((line) => /Available models|Models matching/i.test(line)) || !lines.some((line) => /Tab to edit/i.test(line))) {
    return null
  }
  const selected = lines.findLast((line) => /^\s*→\s+/.test(line))
  if (!selected) return { selectedFamily: null }
  const value = selected.replace(/^\s*→\s+/, '').replace(/\s+\(Tab to modify\)\s*$/i, '')
  return { selectedFamily: value.split(/\s{2,}/)[0]?.trim() || null }
}

export function parseCursorParameterRows(capture: string): CursorParameterRow[] | null {
  const lines = stripAnsi(capture).split('\n')
  if (!lines.some((line) => /— Edit Parameters/i.test(line))) return null
  const rows: CursorParameterRow[] = []
  let section: 'context' | 'reasoning' | null = null
  for (const raw of lines) {
    const line = raw.replace(/\u00a0/g, ' ')
    if (/^\s*Context\s*$/.test(line)) { section = 'context'; continue }
    if (/^\s*Reasoning\s*$/.test(line)) { section = 'reasoning'; continue }
    const choice = /^\s*(→)?\s*([●○◉◯])\s+(.+?)(?:\s+✓)?\s*$/.exec(line)
    if (!choice) continue
    const label = choice[3].trim()
    let kind: CursorParameterRow['kind']
    let value: string
    if (/^Fast$/i.test(label)) {
      kind = 'fast'
      value = 'true'
    } else if (/^Thinking$/i.test(label)) {
      kind = 'thinking'
      value = 'true'
    } else if (section === 'context') {
      kind = 'context'
      value = label.toLowerCase()
    } else if (section === 'reasoning') {
      kind = 'reasoning'
      value = label.toLowerCase().replace(/\s+/g, '') === 'extrahigh'
        ? 'xhigh'
        : label.toLowerCase()
    } else {
      continue
    }
    rows.push({
      kind,
      value,
      selected: choice[2] === '●' || choice[2] === '◉' || /✓\s*$/.test(line),
      cursor: !!choice[1],
      index: rows.length,
    })
  }
  return rows.length ? rows : null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class RuntimeProfileController {
  constructor(private readonly deps: RuntimeProfileControllerDeps) {}

  async setProfile(sessionId: string, encoded: unknown): Promise<void> {
    const registeredSession = this.deps.getSession(sessionId)
    if (!registeredSession) throw new RuntimeProfileControlError('AGENT_NOT_FOUND')
    const observed = this.deps.manager.getState(registeredSession.sessionId)
    // Keep transaction cleanup on the conversation that began it, even if the registry row
    // is rebound in place while a native driver awaits its worker.
    const session: RegisteredSession = structuredClone(registeredSession)
    session.cliVersion ||= observed.cliVersion
    const native = this.deps.modelControlFor(session)
    const target = parseRuntimeProfile(encoded)
    // Either id identifies the agent: the encoded profile now carries the agent id, but one minted
    // before the id cutover (or by a client that still knows the session) must keep working.
    if (!target || (target.sessionId !== session.agentId && target.sessionId !== session.sessionId) || target.engine !== session.engine) {
      throw new RuntimeProfileControlError('INVALID_RUNTIME_PROFILE')
    }
    const current = parseRuntimeProfile(this.deps.manager.selectedModel(session))
    if (current?.id === target.id) return
    if (!await this.deps.manager.supportsControl(session)) {
      console.warn(`[runtime-profile] unsupported ${session.engine} CLI version ${session.cliVersion ?? 'unknown'} for ${sessionId.slice(0, 8)}`)
      throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')
    }
    await native?.validate({ stage: 'target', target, state: observed })
    const options = await this.deps.manager.modelsForSession(session)
    if (!options.some((option) => option.id === target.id)) {
      const sameModel = options.some((option) => parseRuntimeProfile(option.id)?.model === target.model)
      throw new RuntimeProfileControlError(sameModel ? 'EFFORT_UNSUPPORTED' : 'MODEL_UNAVAILABLE')
    }
    await native?.validate({ stage: 'scope', target, state: observed })
    const release = this.deps.acquireInput(session.agentId)
    if (!release) throw new RuntimeProfileControlError('BUSY')
    let controlStarted = false
    let pickerOpen = false
    try {
      if (!await this.deps.validateRuntime(session)) throw new RuntimeProfileControlError('TMUX_FAILED')
      const capture = await this.deps.capture(session.agentId, 100)
      if (!capture) throw new RuntimeProfileControlError('TMUX_FAILED')
      const inspection = (await this.deps.readScreen(session, capture))?.pane
      if (!inspection) throw new RuntimeProfileControlError('BUSY')
      await native?.validate({ stage: 'scope', target, state: observed, pane: inspection })
      if (!inspection.idle) throw new RuntimeProfileControlError('BUSY')
      if (!this.deps.manager.beginControl(session, target)) throw new RuntimeProfileControlError('BUSY')
      controlStarted = true
      if (native) {
        await native.apply({ target, current, options })
      } else if (session.engine === 'devin') {
        // No picker is ever opened — `/model <id>` is a single command — so there is nothing to Escape out
        // of if this throws.
        await this.setDevin(session, target)
      } else if (session.engine === 'pi') {
        pickerOpen = true
        await this.setPi(session, target, current)
        pickerOpen = false
      } else if (session.engine === 'opencode') {
        pickerOpen = true
        await this.setOpencode(session, target)
        pickerOpen = false
      } else if (session.engine === 'hermes') {
        pickerOpen = true
        await this.setHermes(session, target)
        pickerOpen = false
      } else if (session.engine === 'commandcode') {
        // Two plain commands, no dialog — nothing to Escape out of if either throws.
        await this.setCommandcode(session, target, current)
      } else {
        pickerOpen = true
        await this.setCursor(session, target)
        pickerOpen = false
      }
      this.deps.manager.finishControl(session)
      controlStarted = false
    } catch (error) {
      if (pickerOpen) {
        for (let attempt = 0; attempt < 3; attempt++) {
          await this.deps.sendKey(session.agentId, 'Escape').catch(() => false)
          await sleep(100)
          const next = await this.deps.capture(session.agentId, 100).catch(() => null)
          if (!next || !(await this.deps.readScreen(session, next))?.pane.dialog) break
        }
      }
      // By the engine session, as beginControl keyed it. `sessionId` is whichever id the request named,
      // and the apps name the agent: cancelling under that left the control in place, and every later
      // switch of the agent answered BUSY until the daemon restarted (found by e2e/models.e2e.ts, a
      // refused switch followed by one that should have gone through).
      if (controlStarted) this.deps.manager.cancelControl(session.sessionId)
      // A failed switch used to leave NOTHING in the log — the picker just flashed open and shut on the
      // user's terminal and the device said nothing useful. Name the session, engine and reason.
      const code = error instanceof RuntimeProfileControlError ? error.code : 'TMUX_FAILED'
      console.warn(`[runtime-profile] ${sessionId.slice(0, 8)} ${session.engine} set ${target.model}@${target.effort} failed: ${code}`)
      if (error instanceof RuntimeProfileControlError) throw error
      throw new RuntimeProfileControlError('TMUX_FAILED')
    } finally {
      release()
    }
  }

  /**
   * Devin takes the whole profile in one command: `/model <id>` accepts the exact id from
   * `devin models list` (effort included), and answers in the pane — `✓ Model set to <name>` or
   * `✗ Model not available`. That explicit answer is why devin needs no picker driving at all, and why an
   * unavailable model (most of them, on a free plan) fails fast instead of timing out.
   */
  private async setDevin(session: RegisteredSession, target: RuntimeProfile): Promise<void> {
    const devin = this.deps.manager.devinTarget(session.sessionId, target.id)
    if (!devin) throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
    if (!await this.deps.sendText(session.agentId, `/model ${devin.id}`)) {
      throw new RuntimeProfileControlError('TMUX_FAILED')
    }
    const answered = await this.waitPane(
      session.agentId,
      (value) => devinModelCommandResult(stripAnsi(value)) !== null,
      COMMAND_CONFIRM_MS,
    )
    if (!answered) throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
    if (devinModelCommandResult(stripAnsi(answered)) === 'unavailable') {
      throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
    }
    // The acknowledgement line is not the state — the footer is, and only `ingestPane` reads it. Nothing
    // else feeds the manager during a control, so the wait has to do the feeding itself (same shape as
    // setCursor); waiting on `waitForProfile` alone timed out on a switch that had already landed.
    if (!await this.waitObservedProfile(session, target)) {
      throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
    }
  }

  /**
   * Pi splits the axes: `/model <provider/model>` takes a target directly, while the thinking level lives
   * only in `/settings` → "Thinking Level", a fixed ladder walked with the arrow keys. Both were driven by
   * hand first; the ladder's order is what makes the arrow count deterministic (see PI_THINKING_LEVELS).
   */
  private async setPi(
    session: RegisteredSession,
    target: RuntimeProfile,
    current: RuntimeProfile | null,
  ): Promise<void> {
    if (current?.model !== target.model) {
      if (!await this.deps.sendText(session.agentId, `/model ${target.model}`)) {
        throw new RuntimeProfileControlError('TMUX_FAILED')
      }
      if (!await this.deps.manager.waitForModel(session.sessionId, COMMAND_CONFIRM_MS)) {
        throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
      }
    }
    if (target.effort === 'auto' || current?.effort === target.effort) {
      this.deps.manager.confirmEffort(session.sessionId, target.effort)
      return
    }
    await this.setPiThinking(session, target)
  }

  private async setPiThinking(session: RegisteredSession, target: RuntimeProfile): Promise<void> {
    const effort = target.effort
    if (!await this.deps.sendText(session.agentId, '/settings')) {
      throw new RuntimeProfileControlError('TMUX_FAILED')
    }
    if (!await this.waitPane(session.agentId, (v) => /Type to search/i.test(stripAnsi(v)), PICKER_OPEN_MS)) {
      throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
    }
    // Typing alone is enough: the settings filter opens a row the moment it narrows to one. Submitting
    // here would land an Enter on the ladder that just opened and pick the level already highlighted —
    // which is the CURRENT one, so the switch silently did nothing.
    if (!await this.deps.sendLiteral(session.agentId, 'thinking level')) {
      throw new RuntimeProfileControlError('TMUX_FAILED')
    }
    const ladder = await this.waitPane(
      session.agentId,
      (v) => /Select reasoning depth/i.test(stripAnsi(v)),
      PICKER_OPEN_MS,
    )
    if (!ladder) throw new RuntimeProfileControlError('EFFORT_UNSUPPORTED')

    // Walk the ladder ONE key at a time, re-reading the cursor after each. Counting the steps up front and
    // firing them blind is what an open-loop drive looks like, and it is exactly how this went wrong: a
    // stale first read sent the cursor to `off` and committed it. Re-reading also means a ladder that
    // scrolls, clamps at an end, or gains a level cannot desynchronise the walk.
    let selection = parsePiThinkingSelection(stripAnsi(ladder))
    if (!selection || piThinkingSteps(selection, effort) === null) {
      throw new RuntimeProfileControlError('EFFORT_UNSUPPORTED')
    }
    for (let guard = 0; selection !== effort && guard < PI_LADDER_MAX_STEPS; guard++) {
      const steps = piThinkingSteps(selection as string, effort)
      if (steps === null || steps === 0) break
      if (!await this.deps.sendKey(session.agentId, steps > 0 ? 'Down' : 'Up')) {
        throw new RuntimeProfileControlError('TMUX_FAILED')
      }
      const moved = await this.waitPane(
        session.agentId,
        (value) => {
          const next = parsePiThinkingSelection(stripAnsi(value))
          return !!next && next !== selection
        },
        PICKER_STEP_MS,
      )
      // No movement means the cursor is pinned at an end of the ladder — pressing on cannot reach it.
      if (!moved) throw new RuntimeProfileControlError('EFFORT_UNSUPPORTED')
      selection = parsePiThinkingSelection(stripAnsi(moved))
    }
    if (selection !== effort) throw new RuntimeProfileControlError('EFFORT_UNSUPPORTED')
    await this.deps.sendKey(session.agentId, 'Enter')
    // The ladder returns to the settings list; Escape closes it so the pane is idle again.
    await this.deps.sendKey(session.agentId, 'Escape')
    if (!await this.waitObservedProfile(session, target)) {
      throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
    }
  }

  /** Poll the pane INTO the manager until it reports the profile we asked for. */
  private async waitObservedProfile(session: RegisteredSession, target: RuntimeProfile): Promise<boolean> {
    const confirmed = await this.waitPane(session.agentId, async (value) => {
      await this.deps.manager.ingestPane(session, value, true)
      return this.deps.manager.selectedModel(session) === target.id
    }, COMMAND_CONFIRM_MS)
    return !!confirmed
  }

  /**
   * OpenCode switches through `/models`, a picker with a typed filter. It is driven by NARROWING, never by
   * arrowing: type the model's words plus its provider's, and press Enter only once exactly one row is
   * left and that row is the requested model. If the filter leaves two rows (two providers can carry the
   * same model name) the switch is refused rather than guessed — picking the wrong model silently is worse
   * than not switching, and blind arrow-driving is what sank the Command Code attempt.
   */
  private async setOpencode(session: RegisteredSession, target: RuntimeProfile): Promise<void> {
    const entry = (await this.deps.manager.opencodeCatalog()).find((item) => item.id === target.model)
    if (!entry) throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
    await this.driveOpencodePicker(session, entry)
    if (!await this.waitObservedProfile(session, target)) {
      throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
    }
  }

  /**
   * `/models`, filter, act only once exactly one row is left.
   *
   * Two attempts, because one filter does not fit both renders. With several providers connected a
   * row carries its provider (`Big Pickle OpenCode Zen`) and the provider-qualified filter is what
   * tells two same-named models apart; with one provider the row is bare (`Big Pickle`) and that same
   * filter matches NOTHING. Measured on a live picker: `big pickle opencode` → empty, `big pickle` →
   * the row.
   *
   * The fallback drops only the PROVIDER half, never the "exactly one row" rule — which is what makes
   * it safe: if one model answers to the name, there is no second provider to confuse it with, and if
   * two do, the list does not narrow and this refuses rather than guessing.
   */
  private async driveOpencodePicker(session: RegisteredSession, entry: OpencodeModelTarget): Promise<void> {
    if (await this.pickOpencodeRow(session, entry, entry.filter, opencodeRowMatches)) return
    if (entry.modelFilter === entry.filter) throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
    if (!await this.pickOpencodeRow(session, entry, entry.modelFilter, opencodeRowNamesModel)) {
      throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
    }
  }

  /**
   * One attempt at the picker: open it, type `filter`, and press Enter only if exactly one row is left
   * AND `matches` accepts it. Returns false — with the picker CLOSED — when the list did not narrow to
   * a row this may act on, so the caller can try a different filter on a pane in its resting state.
   * Throws only for the states no retry can help: tmux refusing input, or the picker never opening.
   */
  private async pickOpencodeRow(
    session: RegisteredSession,
    entry: OpencodeModelTarget,
    filter: string,
    matches: (target: OpencodeModelTarget, row: OpencodePickerRow) => boolean,
  ): Promise<boolean> {
    // "Is a picker open?" cannot be asked of a capture that carries scrollback — an EARLIER picker is
    // still up there, so the check passes before this one opens and the filter would be typed into the
    // composer and submitted as a message. Count the openings instead and wait for one more.
    const before = countOpencodePickers(stripAnsi(await this.deps.capture(session.agentId, 100) ?? ''))
    if (!await this.deps.sendText(session.agentId, '/models')) {
      throw new RuntimeProfileControlError('TMUX_FAILED')
    }
    if (!await this.waitPane(
      session.agentId,
      (v) => countOpencodePickers(stripAnsi(v)) > before,
      PICKER_OPEN_MS,
    )) {
      throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
    }
    if (!await this.deps.sendLiteral(session.agentId, filter)) {
      throw new RuntimeProfileControlError('TMUX_FAILED')
    }
    const narrowed = await this.waitPane(
      session.agentId,
      (v) => (parseOpencodePickerRows(stripAnsi(v)) ?? []).length === 1,
      PICKER_STEP_MS,
    )
    const rows = narrowed ? parseOpencodePickerRows(stripAnsi(narrowed)) ?? [] : []
    if (rows.length !== 1 || !matches(entry, rows[0])) {
      // Leave the pane as it was found. A picker left open with a dead filter in it swallows whatever
      // the user types next, and the retry below would type its filter on top of this one.
      await this.deps.sendKey(session.agentId, 'Escape')
      return false
    }
    if (!await this.deps.sendKey(session.agentId, 'Enter')) {
      throw new RuntimeProfileControlError('TMUX_FAILED')
    }
    return true
  }

  /**
   * Command Code 1.6.0 takes both axes as arguments: `/model <vendor/id>` and `/effort <level>`. Neither
   * opens a dialog, which is the whole reason switching is back after the 2026-07-30 revert — the version
   * gate in supportsNativeRuntimeControl keeps older builds, where only an arrow-driven picker existed,
   * out of this path.
   *
   * Effort is per model and the catalog does not say which models have one, so a refusal is expected
   * traffic: the CLI answers "Reasoning effort not supported for X." and that becomes EFFORT_UNSUPPORTED.
   */
  private async setCommandcode(
    session: RegisteredSession,
    target: RuntimeProfile,
    current: RuntimeProfile | null,
  ): Promise<void> {
    const entry = this.deps.manager.commandcodeTarget(session.sessionId, target.id)
    if (!entry) throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')

    if (current?.model !== target.model) {
      if (!await this.deps.sendText(session.agentId, `/model ${entry.id}`)) {
        throw new RuntimeProfileControlError('TMUX_FAILED')
      }
      if (!await this.waitObservedModel(session, target)) {
        throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
      }
    }

    if (target.effort === 'auto' || current?.effort === target.effort) {
      this.deps.manager.confirmEffort(session.sessionId, target.effort)
      return
    }
    // Success prints NOTHING and a refusal prints one line, so both have to be watched at once — and the
    // refusal has to be a NEW one. Matching the text anywhere in the capture reported failure in 25ms off
    // a refusal still sitting in the scrollback from an earlier model, while the level had in fact applied.
    const refusalsBefore = countCommandcodeRefusals(stripAnsi(await this.deps.capture(session.agentId, 100) ?? ''))
    if (!await this.deps.sendText(session.agentId, `/effort ${target.effort}`)) {
      throw new RuntimeProfileControlError('TMUX_FAILED')
    }
    const deadline = Date.now() + COMMAND_CONFIRM_MS
    while (Date.now() < deadline) {
      // The level is recorded only in the CLI's global config, so confirming it means re-reading that.
      await this.deps.manager.ingestConfig(session, true).catch(() => false)
      if (this.deps.manager.selectedModel(session) === target.id) return
      const capture = stripAnsi(await this.deps.capture(session.agentId, 100) ?? '')
      if (countCommandcodeRefusals(capture) > refusalsBefore) {
        throw new RuntimeProfileControlError('EFFORT_UNSUPPORTED')
      }
      await sleep(150)
    }
    throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
  }

  /**
   * Hermes' `/model` is a two-level picker — provider page, then that provider's models — with no way to
   * type or jump. It is walked one arrow at a time, re-reading the `❯` cursor after every key, so a page
   * that scrolls or reorders cannot desynchronise the walk. If the cursor stops moving before it reaches
   * the target, the target is not on the page and the switch is refused rather than committed blind.
   *
   * Only MODELS are switchable; hermes keeps its reasoning effort in config.yaml with no in-session
   * command, so hermesModels never offers an effort row to get here (see hermesModels).
   */
  private async setHermes(session: RegisteredSession, target: RuntimeProfile): Promise<void> {
    const entry = this.deps.manager.hermesTarget(session.sessionId, target.id)
    if (!entry) throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
    if (!await this.deps.sendText(session.agentId, '/model')) {
      throw new RuntimeProfileControlError('TMUX_FAILED')
    }
    const opened = await this.waitPane(
      session.agentId,
      (v) => !!parseHermesPickerPage(stripAnsi(v)),
      PICKER_OPEN_MS,
    )
    if (!opened) throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')

    // Page 1: the provider. Its row reads "Anthropic (13 models)", so match on the leading name.
    if (entry.provider) {
      await this.walkHermesPage(session, (row) => hermesProviderMatches(row, entry.provider))
      if (!await this.waitPane(
        session.agentId,
        (v) => (parseHermesPickerPage(stripAnsi(v))?.rows ?? []).some((row) => row === entry.id),
        PICKER_OPEN_MS,
      )) {
        throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
      }
    }
    // Page 2: the model itself, listed by exact id.
    await this.walkHermesPage(session, (row) => row === entry.id)
    if (!await this.waitObservedModel(session, target)) {
      throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
    }
  }

  /** Move the `❯` cursor onto the row `wanted` selects, then commit it with Enter. */
  private async walkHermesPage(
    session: RegisteredSession,
    wanted: (row: string) => boolean,
  ): Promise<void> {
    for (let guard = 0; guard < HERMES_PAGE_MAX_STEPS; guard++) {
      const capture = await this.deps.capture(session.agentId, 100)
      const page = capture ? parseHermesPickerPage(stripAnsi(capture)) : null
      if (!page || !page.selected) throw new RuntimeProfileControlError('TMUX_FAILED')
      if (wanted(page.selected)) {
        if (!await this.deps.sendKey(session.agentId, 'Enter')) {
          throw new RuntimeProfileControlError('TMUX_FAILED')
        }
        return
      }
      const at = page.rows.indexOf(page.selected)
      const to = page.rows.findIndex(wanted)
      if (to < 0) throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
      if (!await this.deps.sendKey(session.agentId, to > at ? 'Down' : 'Up')) {
        throw new RuntimeProfileControlError('TMUX_FAILED')
      }
      const moved = await this.waitPane(session.agentId, (v) => {
        const next = parseHermesPickerPage(stripAnsi(v))
        return !!next?.selected && next.selected !== page.selected
      }, PICKER_STEP_MS)
      if (!moved) throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
    }
    throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
  }

  /** Like waitObservedProfile, but only the model half — used where effort is applied separately. */
  private async waitObservedModel(session: RegisteredSession, target: RuntimeProfile): Promise<boolean> {
    const confirmed = await this.waitPane(session.agentId, async (value) => {
      await this.deps.manager.ingestPane(session, value, true)
      return parseRuntimeProfile(this.deps.manager.selectedModel(session))?.model === target.model
    }, COMMAND_CONFIRM_MS)
    return !!confirmed
  }

  private async setCursor(session: RegisteredSession, target: RuntimeProfile): Promise<void> {
    const cursorTarget = this.deps.manager.cursorTarget(session.sessionId, target.id)
    if (!cursorTarget) throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
    if (!await this.deps.sendText(session.agentId, `/model ${cursorTarget.familyLabel}`)) {
      throw new RuntimeProfileControlError('TMUX_FAILED')
    }
    let capture = await this.waitPane(session.agentId, (value) => !!parseCursorModelPicker(value), 900)
    if (!capture) {
      if (!await this.deps.sendKey(session.agentId, 'Enter')) throw new RuntimeProfileControlError('TMUX_FAILED')
      capture = await this.waitPane(session.agentId, (value) => !!parseCursorModelPicker(value), PICKER_OPEN_MS)
    }
    const picker = capture ? parseCursorModelPicker(capture) : null
    if (!picker || picker.selectedFamily?.toLowerCase() !== cursorTarget.familyLabel.toLowerCase()) {
      throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')
    }

    if (cursorTarget.rawId !== 'auto') {
      if (!await this.deps.sendKey(session.agentId, 'Tab')) throw new RuntimeProfileControlError('TMUX_FAILED')
      capture = await this.waitPane(session.agentId, (value) => !!parseCursorParameterRows(value), PICKER_STEP_MS)
      if (!capture) throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')

      if (cursorTarget.context) {
        await this.setCursorParameter(session, 'context', cursorTarget.context, true)
      }
      if (cursorTarget.reasoning) {
        await this.setCursorParameter(session, 'reasoning', cursorTarget.reasoning, true)
      }
      await this.setCursorParameter(session, 'thinking', 'true', cursorTarget.thinking ?? false)
      await this.setCursorParameter(session, 'fast', 'true', cursorTarget.fast ?? false)

      if (!await this.deps.sendKey(session.agentId, 'Escape')) throw new RuntimeProfileControlError('TMUX_FAILED')
      if (!await this.waitPane(session.agentId, (value) => !!parseCursorModelPicker(value), PICKER_STEP_MS)) {
        throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')
      }
      if (!await this.deps.sendKey(session.agentId, 'Enter')) throw new RuntimeProfileControlError('TMUX_FAILED')
    } else {
      if (!await this.deps.sendKey(session.agentId, 'Enter')) throw new RuntimeProfileControlError('TMUX_FAILED')
    }

    const confirmed = await this.waitPane(session.agentId, async (value) => {
      await this.deps.manager.ingestPane(session, value, true)
      return this.deps.manager.selectedModel(session) === target.id
        || this.cursorFooterMatches(value, cursorTarget, target.effort)
    }, COMMAND_CONFIRM_MS)
    if (!confirmed) throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
    if (this.deps.manager.selectedModel(session) !== target.id) {
      this.deps.manager.confirmControlProfile(target)
    }
  }

  private async setCursorParameter(
    session: RegisteredSession,
    kind: CursorParameterRow['kind'],
    value: string,
    selected: boolean,
  ): Promise<void> {
    const capture = await this.deps.capture(session.agentId, 100)
    const rows = capture ? parseCursorParameterRows(capture) : null
    if (!rows) throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')
    const target = rows.find((row) => row.kind === kind && row.value === value)
    if (!target) {
      if (!selected && (kind === 'fast' || kind === 'thinking')) return
      throw new RuntimeProfileControlError('EFFORT_UNSUPPORTED')
    }
    if (target.selected === selected) return
    const current = rows.find((row) => row.cursor)
    if (!current) throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')
    const direction = target.index > current.index ? 'Down' : 'Up'
    for (let i = 0; i < Math.abs(target.index - current.index); i++) {
      if (!await this.deps.sendKey(session.agentId, direction)) throw new RuntimeProfileControlError('TMUX_FAILED')
      await sleep(120)
    }
    if (!await this.deps.sendKey(session.agentId, 'Enter')) throw new RuntimeProfileControlError('TMUX_FAILED')
    const updated = await this.waitPane(session.agentId, (next) => {
      const nextRows = parseCursorParameterRows(next)
      return nextRows?.some((row) => row.kind === kind && row.value === value && row.selected === selected) ?? false
    }, PICKER_STEP_MS)
    if (!updated) throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
  }

  private cursorFooterMatches(
    capture: string,
    target: CursorModelTarget,
    effort: string | null,
  ): boolean {
    const lines = stripAnsi(capture).split('\n').filter((line) => line.trim()).slice(-15)
    if (target.rawId === 'auto') return lines.some((line) => /^\s*Auto(?:\s*$|\s*[·│])/i.test(line))
    return lines.some((line) => {
      const normalized = line.trim().toLowerCase()
      if (!normalized.startsWith(target.familyLabel.toLowerCase())) return false
      const actualFast = /\bfast\b/i.test(line)
      const actualThinking = !/\bno\s+thinking\b/i.test(line) && /\bthinking\b/i.test(line)
      if (target.fast != null && actualFast !== target.fast) return false
      if (target.thinking != null && actualThinking !== target.thinking) return false
      if (target.context && !normalized.includes(target.context)) return false

      const effortMatch = /\b(extra high|none|low|medium|high|max)\b/i.exec(line)
      const actualEffort = effortMatch?.[1].toLowerCase().replace(/\s+/g, '') === 'extrahigh'
        ? 'xhigh'
        : effortMatch?.[1].toLowerCase() ?? null
      const footerEffort = target.footerEffort === undefined ? effort : target.footerEffort
      return footerEffort == null ? actualEffort == null : actualEffort === footerEffort
    })
  }

  private async waitPane(terminalTarget: string, predicate: (capture: string) => boolean | Promise<boolean>, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const capture = await this.deps.capture(terminalTarget, 100)
      if (capture && await predicate(capture)) return capture
      await sleep(100)
    }
    return null
  }
}
