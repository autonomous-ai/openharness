/** Codex owns its picker walk and cleanup; the host can revoke every requested effect. */
import { chooseCodexRow, codexDigitPressable, codexEffortRows, parseCodexPicker, sameCodexPicker, type CodexCatalogModel, type CodexPicker } from './modelPicker.js'
import { runtime } from './runtimeProfile.js'
import { screen } from './screen.js'
import { RuntimeProfileControlError, type EngineModelControl, type ModelControlHost, type ModelControlInput } from '../facets/modelControl.js'
import type { RuntimeProfile } from '../facets/runtime.js'
const COMMAND_CONFIRM_MS = 8_000
const PICKER_OPEN_MS = 3_000
const PICKER_STEP_MS = 2_000
// A refreshed catalog can renumber a picker in place. A digit needs two matching reads.
const CODEX_SETTLE_MS = 250
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
function isCodexList(picker: CodexPicker): boolean {
  return picker.kind === 'quick' || picker.kind === 'models' || picker.kind === 'reserve'
}

export const modelControl: EngineModelControl = {
  async validate({ stage, target, catalog, state, pane }) {
    if (stage === 'target') {
      const listed = catalog.find(entry => entry.slug === target.model)?.efforts ?? null
      if (!runtime.effortAllowed!(target.model, target.effort, listed)) throw new RuntimeProfileControlError('EFFORT_UNSUPPORTED')
    } else if (state.mode === 'plan' || pane?.plan) throw new RuntimeProfileControlError('PLAN_SCOPE_AMBIGUOUS')
  },
  apply: (input, host) => new CodexModelControl(host).apply(input),
}

class CodexModelControl {
  constructor(private readonly host: ModelControlHost) {}
  async apply({ target, catalog }: ModelControlInput): Promise<void> {
    try {
      await this.setCodex(target, catalog)
    } catch (error) {
      // Cleanup still goes through the same grant. A dead or revoked host cannot
      // press Escape later, into a different question or a replacement engine.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!await this.host.key('Escape').catch(() => false)) break
        await sleep(100)
        const next = await this.host.capture(100).catch(() => null)
        if (!next || !screen.inspect(next).pane.dialog) break
      }
      throw error
    }
  }

  /**
   * Codex's `/model`: a quick menu of auto presets with an `All models` row (0.145 and later), the full
   * list (`Select Model and Effort`), then the chosen model's reasoning picker, each row pressed by its
   * digit, which selects the row and accepts it. How a row is read and chosen, and why, is in
   * engines/codex/modelPicker.ts. Confirmed, as it always was, by the `thread_settings_applied` record
   * Codex writes once the choice is applied (RuntimeProfileManager `ingestCodex`).
   */
  private async setCodex(target: RuntimeProfile, catalog: CodexCatalogModel[]): Promise<void> {
    if (!await this.host.text('/model')) throw new RuntimeProfileControlError('TMUX_FAILED')
    let picker = await this.waitCodexPicker(() => true, 900)
    if (!picker) {
      await this.host.key('Enter')
      picker = await this.waitCodexPicker(() => true, PICKER_OPEN_MS)
    }
    if (!picker) throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')
    if (!isCodexList(picker)) {
      // Opened on a reasoning screen: back to the list it was opened from, so the model is chosen too.
      if (!await this.host.key('Escape')) throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')
      if (!await this.waitCodexPicker(isCodexList, PICKER_STEP_MS)) throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')
    }
    const reached = await this.reachCodexEfforts(target, catalog)
    if (reached !== 'applied') await this.pickCodexEffort(target, reached)
    if (!await this.host.waitForProfile(COMMAND_CONFIRM_MS)) {
      throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
    }
  }

  /**
   * From the list on screen to the target model's reasoning picker, through `All models` when the quick
   * menu is first; or 'applied' when the model's row applied it at once (a model with one effort).
   *
   * Every digit is pressed from a list read twice, CODEX_SETTLE_MS apart, the same both times. Codex
   * 0.160 draws the list from its cache and redraws it in place when the server answers, and a model
   * added or reordered then renumbers the rows: a digit read off the first drawing lands on another
   * model. The reasoning picker that opens names its model in its title, and a title naming any other
   * model than the row pressed means the list moved anyway, so nothing more is pressed.
   */
  private async reachCodexEfforts(
    target: RuntimeProfile,
    catalog: CodexCatalogModel[],
  ): Promise<CodexPicker | 'applied'> {
    let reread = false
    for (let lists = 0; lists < 2; lists++) {
      const list = await this.settledCodexList()
      if (!list) throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
      let choice = chooseCodexRow(list, target, catalog)
      if ('error' in choice && choice.error === 'MODEL_UNAVAILABLE' && !reread) {
        // Codex saves the catalog its picker refreshed from to models_cache.json, so a model or a name
        // that came with the refresh is there to read now.
        reread = true
        catalog = await this.host.catalog()
        choice = chooseCodexRow(list, target, catalog)
      }
      if ('error' in choice) throw new RuntimeProfileControlError(choice.error)
      if (!await this.host.key(String(choice.row.number))) throw new RuntimeProfileControlError('TMUX_FAILED')
      if (choice.opens === 'list') {
        if (!await this.waitCodexPicker((next) => next.kind === 'models', PICKER_STEP_MS)) {
          throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')
        }
        continue
      }
      if (choice.opens === 'applied') return 'applied'
      const next = await this.waitCodexAfterModelRow()
      if (next === 'closed') return 'applied'
      if (!next) throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')
      if (next.model !== choice.row.name) throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
      return next
    }
    throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
  }

  /** The target's effort in its reasoning picker, through Advanced Reasoning for Max and Ultra. */
  private async pickCodexEffort(target: RuntimeProfile, picker: CodexPicker): Promise<void> {
    const rows = codexEffortRows(picker)
    let row = target.effort === 'auto' ? rows.defaultRow : rows.efforts.get(target.effort) ?? null
    if (row === null && (target.effort === 'max' || target.effort === 'ultra') && rows.advancedRow !== null
      && codexDigitPressable(rows.advancedRow)) {
      if (!await this.host.key(String(rows.advancedRow))) throw new RuntimeProfileControlError('TMUX_FAILED')
      const advanced = await this.waitCodexPicker((next) => next.kind === 'advanced', PICKER_STEP_MS)
      row = advanced ? codexEffortRows(advanced).efforts.get(target.effort) ?? null : null
    }
    if (row === null || !codexDigitPressable(row)) throw new RuntimeProfileControlError('EFFORT_UNSUPPORTED')
    if (!await this.host.key(String(row))) throw new RuntimeProfileControlError('TMUX_FAILED')
  }

  /** The first Codex picker on the pane that `wanted` takes, polled until `timeoutMs`. */
  private async waitCodexPicker(
    wanted: (picker: CodexPicker) => boolean,
    timeoutMs: number,
  ): Promise<CodexPicker | null> {
    const capture = await this.waitPane((value) => {
      const picker = parseCodexPicker(value)
      return !!picker && wanted(picker)
    }, timeoutMs)
    return capture ? parseCodexPicker(capture) : null
  }

  /** A model list that reads the same twice, CODEX_SETTLE_MS apart (see reachCodexEfforts). */
  private async settledCodexList(): Promise<CodexPicker | null> {
    let previous: CodexPicker | null = null
    const deadline = Date.now() + PICKER_STEP_MS
    while (Date.now() < deadline) {
      const capture = await this.host.capture(100)
      const picker = capture ? parseCodexPicker(capture) : null
      const list = picker && isCodexList(picker) ? picker : null
      if (list && previous && sameCodexPicker(previous, list)) return list
      previous = list
      await sleep(CODEX_SETTLE_MS)
    }
    return null
  }

  /**
   * After a model's row: its reasoning picker, or 'closed' when the picker went away and the composer
   * is back, which is a model the catalog did not describe applying its one effort at once.
   */
  private async waitCodexAfterModelRow(): Promise<CodexPicker | 'closed' | null> {
    const deadline = Date.now() + PICKER_STEP_MS
    while (Date.now() < deadline) {
      const capture = await this.host.capture(100)
      if (capture) {
        const picker = parseCodexPicker(capture)
        if (picker?.kind === 'efforts') return picker
        if (!picker && screen.inspect(capture).pane.idle) return 'closed'
      }
      await sleep(100)
    }
    return null
  }

  private async waitPane(predicate: (capture: string) => boolean | Promise<boolean>, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const capture = await this.host.capture(100)
      if (capture && await predicate(capture)) return capture
      await sleep(100)
    }
    return null
  }
}
