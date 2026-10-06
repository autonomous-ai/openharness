/**
 * Codex's `/model` picker, read off the pane, and the one row in it that names a model.
 *
 * Harness switches a Codex agent's model by typing into this picker (lib/runtimeProfileController.ts
 * `setCodex`), so everything here is read from how Codex draws it: `chatwidget/model_popups.rs`,
 * `luna_reserve_model.rs` and `bottom_pane/list_selection_view.rs` at rust-v0.145.0 and rust-v0.160.0,
 * and their insta snapshots. The screens it was built against are in
 * `lib/__fixtures__/codexModelPickers.ts`.
 *
 * What changed between the two, and why this file exists:
 *   - 0.145 drew every model row as its slug (`gpt-5.6-terra`), and the reasoning picker's title named
 *     the slug too. 0.160 draws the catalog's display name (`GPT-6.1-Sol`, `GPT-5.6 Luna`) in both
 *     places. The controller keyed rows by their first slug-like token, so on 0.160 every lookup missed,
 *     and a name with a space did not parse at all. A row is now matched by its whole name, against the
 *     slug and the display name that Codex's own `models_cache.json` gives the target.
 *   - Two models can share a display name (0.160's own test `model_picker_refresh_preserves_highlight`
 *     gives two the same one), and an auto preset can carry an ordinary model's name (its
 *     `model_picker_refreshes_auto_models`). A name that more than one model of the list could carry
 *     picks nothing: pressing the wrong row saves the wrong model as the person's default.
 *   - 0.160 shows its cached models at once and refreshes the list in place when the server answers
 *     (`AppEvent::FetchModels`, model_popup_state.rs), so rows can be renumbered under a reader. The
 *     controller reads the list twice before it presses a digit, and checks the reasoning picker that
 *     opens names the model it pressed (see [chooseCodexRow] and setCodex).
 *   - An account held to the reserve model (`gpt-reserve`, "Luna Reserve") gets a picker of one row,
 *     borrowed from an ordinary model, whose efforts apply to the reserve model alone.
 *   - A new effort, `persistent`, labelled `Persistent`.
 */

/** The reserve model an account out of ordinary usage is held to (tui/src/model_catalog.rs). */
export const CODEX_RESERVE_MODEL = 'gpt-reserve'

/** Max and Ultra are asked for on a second screen, never in the first effort list (model_popups.rs
 *  `is_advanced_reasoning_effort`). */
const ADVANCED_EFFORTS = new Set(['max', 'ultra'])

/**
 * The words Codex labels each effort with (model_popups.rs `reasoning_effort_label`), as the effort
 * Harness calls it. `Extra high` is `xhigh` on the wire.
 */
const EFFORT_LABELS = new Map<string, string>([
  ['none', 'none'], ['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'],
  ['extra high', 'xhigh'], ['max', 'max'], ['ultra', 'ultra'], ['persistent', 'persistent'],
])

/** One model of Codex's catalog, as `models_cache.json` keeps it (protocol/src/openai_models.rs `ModelInfo`). */
export interface CodexCatalogModel {
  slug: string
  displayName: string
  /** In Codex's own picker: `visibility: "list"` (ModelPreset `show_in_picker`). */
  listed: boolean
  /** `default_reasoning_level`; Codex reads a missing one as `none`. */
  defaultEffort: string
  /** `supported_reasoning_levels[].effort`, in the catalog's order. */
  efforts: string[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The models in a parsed `models_cache.json` (models-manager/src/cache.rs `ModelsCacheEntry`). */
export function parseCodexCatalog(cache: unknown): CodexCatalogModel[] {
  const models = record(cache)?.models
  const out: CodexCatalogModel[] = []
  for (const item of Array.isArray(models) ? models : []) {
    const model = record(item)
    const slug = text(model?.slug)
    if (!model || !slug) continue
    const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : []
    out.push({
      slug,
      displayName: text(model.display_name) || slug,
      listed: model.visibility === 'list',
      defaultEffort: text(model.default_reasoning_level).toLowerCase() || 'none',
      efforts: levels.map((level) => text(record(level)?.effort).toLowerCase()).filter(Boolean),
    })
  }
  return out
}

/** The quick presets the first menu lists (model_popups.rs `is_auto_model`). */
export function isCodexAutoModel(slug: string): boolean {
  return slug.startsWith('codex-auto-')
}

/** One numbered row of a Codex picker (list_selection_view.rs `build_rows`). */
export interface CodexPickerRow {
  /** The digit that selects it and accepts it. */
  number: number
  /** The item's name, without the ` (current)` and ` (default)` Codex appends. */
  name: string
  current: boolean
  isDefault: boolean
}

export type CodexPickerKind = 'quick' | 'models' | 'reserve' | 'efforts' | 'advanced'

export interface CodexPicker {
  kind: CodexPickerKind
  /** The model an effort picker is for, as its title names it: the display name on 0.160, the slug on 0.145. */
  model: string | null
  rows: CodexPickerRow[]
}

function plain(value: string): string {
  return value.replace(/\u001b\[[0-9;:?]*[A-Za-z]/g, '').replace(/ /g, ' ')
}

/**
 * The lines under the last composer prompt. Earlier pickers and prompts stay in tmux's history, and
 * only what is below the latest prompt is on screen now. Picker rows use `›` too, but a numbered row
 * is not a prompt.
 */
function currentLines(capture: string): string[] {
  const lines = plain(capture).split('\n')
  const prompt = lines.findLastIndex((line) => {
    const marker = line.search(/[›❯]/u)
    return marker >= 0 && !/^\s*\d+\.\s/.test(line.slice(marker + 1))
  })
  return prompt >= 0 ? lines.slice(prompt) : lines
}

/** The first line of a picker's title. Titles wrap at the pane's width like the rest of the header
 *  (`Paragraph` with `Wrap`), so only their first words are looked for here. */
const TITLE = /^\s*(?:Select (?:Model|Reasoning)\b|Advanced Reasoning\b)/

/**
 * A numbered row: `› ` on the highlighted one, two spaces on the rest, then `<n>. ` and the name
 * (list_selection_view.rs `build_rows`). At most a few columns in: a description that wraps is indented
 * to its own column, far right of that, and may itself start with a number.
 */
const ROW = /^(\s{0,2}[›>]?\s{0,2})(\d+)\.\s(.*)$/

function kindOf(header: string): { kind: CodexPickerKind; model: string | null } | null {
  const effort = /^Select Reasoning Level for (.+)$/.exec(header)
  if (effort) return { kind: 'efforts', model: effort[1].trim() }
  if (header.startsWith('Advanced Reasoning')) return { kind: 'advanced', model: null }
  if (header.startsWith('Select Model and Effort')) return { kind: 'models', model: null }
  if (!header.startsWith('Select Model')) return null
  if (header.includes('Pick a quick auto mode or browse all models')) return { kind: 'quick', model: null }
  if (header.includes('Other models return when ordinary usage is available again')) return { kind: 'reserve', model: null }
  return null
}

/**
 * The rows under a picker's header. A row's name runs to the first gap of two spaces, where the
 * description column starts. In a narrow pane Codex hides the descriptions and wraps a long name onto
 * the next line, indented to where the name starts; that line is part of the name. A row that shows a
 * description truncates its name with `…` instead, which then matches nothing.
 */
function pickerRows(lines: string[]): CodexPickerRow[] {
  const raw: Array<{ number: number; name: string }> = []
  let open: { at: number; column: number } | null = null
  for (const line of lines) {
    const row = ROW.exec(line)
    if (row) {
      const label = row[3].trimEnd()
      const gap = /\s{2,}\S/.exec(label)
      raw.push({ number: Number(row[2]), name: (gap ? label.slice(0, gap.index) : label).trim() })
      open = gap ? null : { at: raw.length - 1, column: row[1].length + row[2].length + 2 }
      continue
    }
    const indent = /^ */.exec(line)![0].length
    if (open && line.trim() && indent === open.column && !/\s{2,}\S/.test(line.trim())) {
      raw[open.at].name += ` ${line.trim()}`
      continue
    }
    open = null
  }
  return raw.map(({ number, name }) => {
    let current = false
    let isDefault = false
    for (let marker = /\s\((current|default)\)$/.exec(name); marker; marker = /\s\((current|default)\)$/.exec(name)) {
      if (marker[1] === 'current') current = true
      else isDefault = true
      name = name.slice(0, marker.index)
    }
    return { number, name: name.trim(), current, isDefault }
  })
}

/**
 * The Codex picker on the pane now, or null when none is. Its header is the title, any subtitle under
 * it (wrapped at the pane's width, so its lines are joined) and the blank lines before the rows.
 */
export function parseCodexPicker(capture: string): CodexPicker | null {
  const lines = currentLines(capture)
  for (let title = lines.length - 1; title >= 0; title--) {
    if (!TITLE.test(lines[title])) continue
    let end = title + 1
    while (end < lines.length && lines[end].trim() && !ROW.test(lines[end])) end++
    const header = lines.slice(title, end).map((line) => line.trim()).join(' ').replace(/\s+/g, ' ')
    const kind = kindOf(header)
    if (!kind) continue
    const rows = pickerRows(lines.slice(end))
    if (!rows.length) continue
    return { ...kind, rows }
  }
  return null
}

/** Whether two reads show the same picker: the same kind and the same rows, numbered the same. */
export function sameCodexPicker(a: CodexPicker, b: CodexPicker): boolean {
  return a.kind === b.kind && a.model === b.model && a.rows.length === b.rows.length
    && a.rows.every((row, index) => {
      const other = b.rows[index]
      return row.number === other.number && row.name === other.name
        && row.current === other.current && row.isDefault === other.isDefault
    })
}

export interface CodexEffortRows {
  /** Effort → its row's digit. */
  efforts: Map<string, number>
  /** The ` (default)` row: what an `auto` profile asks for. */
  defaultRow: number | null
  /** `More reasoning…` (`More reasoning options` before 0.160), which opens Max and Ultra. */
  advancedRow: number | null
}

/** The rows of a reasoning picker or of its Advanced Reasoning screen. */
export function codexEffortRows(picker: CodexPicker): CodexEffortRows {
  const efforts = new Map<string, number>()
  let defaultRow: number | null = null
  let advancedRow: number | null = null
  for (const row of picker.rows) {
    const name = row.name.toLowerCase()
    if (/^more reasoning\b/.test(name)) advancedRow = row.number
    else if (EFFORT_LABELS.has(name)) efforts.set(EFFORT_LABELS.get(name)!, row.number)
    if (row.isDefault) defaultRow = row.number
  }
  return { efforts, defaultRow, advancedRow }
}

/**
 * Whether a digit can press this row. A digit selects AND accepts its row, and Codex reads one digit
 * per key (list_selection_view.rs: `c.to_digit(10)`), so `1` then `0` would accept row 1; the terminal
 * layer sends single digits only. Row 10 and beyond have no key.
 */
export function codexDigitPressable(row: number): boolean {
  return Number.isInteger(row) && row >= 1 && row <= 9
}

/** What pressing a row does. */
export type CodexRowChoice =
  /** `All models`: opens the full list. */
  | { row: CodexPickerRow; opens: 'list' }
  /** A model with a choice of efforts: opens its reasoning picker. */
  | { row: CodexPickerRow; opens: 'efforts' }
  /** A model with one effort: applied at once, with this effort, and saved as the default. */
  | { row: CodexPickerRow; opens: 'applied'; effort: string }
  /** A model the catalog does not describe: one of the two above, told apart by what the pane shows next. */
  | { row: CodexPickerRow; opens: 'unknown' }
  | { error: 'MODEL_UNAVAILABLE' | 'EFFORT_UNSUPPORTED' }

function names(row: CodexPickerRow, model: { slug: string; displayName: string | null }): boolean {
  return row.name === model.displayName || row.name === model.slug
}

/**
 * The effort a row applies without opening a reasoning picker, or null when it opens one. A quick
 * preset applies its default unless it has Max or Ultra (model_popups.rs `requires_advanced_selection`);
 * a model of the full list applies its only effort, when it has one ordinary effort and no advanced one
 * (`open_reasoning_popup`, the same in 0.145 and 0.160).
 */
function appliedAtOnce(entry: CodexCatalogModel, quick: boolean): string | null {
  if (quick) {
    const advanced = ADVANCED_EFFORTS.has(entry.defaultEffort) || entry.efforts.some((effort) => ADVANCED_EFFORTS.has(effort))
    return advanced ? null : entry.defaultEffort
  }
  const choices = entry.efforts.length ? entry.efforts : [entry.defaultEffort]
  const ordinary = choices.filter((effort) => !ADVANCED_EFFORTS.has(effort))
  return ordinary.length === 1 && ordinary.length === choices.length ? ordinary[0] : null
}

/**
 * The row of a model list that a target model and effort is reached through, or why there is none.
 *
 * Fails closed: a row is chosen only when exactly one row names the target, by its slug or by its
 * catalog display name, and no other model the list could hold carries that name. Anything less
 * answers MODEL_UNAVAILABLE and nothing is pressed, because a digit applies the row it lands on and
 * saves it as the person's default model.
 */
export function chooseCodexRow(
  picker: CodexPicker,
  target: { model: string; effort: string },
  catalog: CodexCatalogModel[],
): CodexRowChoice {
  if (picker.kind === 'reserve') {
    // One row, standing for the reserve model under an ordinary model's name; nothing else can be picked
    // until ordinary usage is back (backend_banners.rs `restrict_model_picker_to_luna_reserve`).
    const [row] = picker.rows
    if (target.model !== CODEX_RESERVE_MODEL || picker.rows.length !== 1 || !codexDigitPressable(row.number)) {
      return { error: 'MODEL_UNAVAILABLE' }
    }
    return { row, opens: 'unknown' }
  }
  if (picker.kind !== 'quick' && picker.kind !== 'models') return { error: 'MODEL_UNAVAILABLE' }
  const quick = picker.kind === 'quick'
  const entry = catalog.find((model) => model.slug === target.model) ?? null
  if (quick && !isCodexAutoModel(target.model)) {
    // The quick menu lists auto presets only; every other model is behind `All models`.
    const all = picker.rows.filter((row) => row.name === 'All models')
    return all.length === 1 && codexDigitPressable(all[0].number) ? { row: all[0], opens: 'list' } : { error: 'MODEL_UNAVAILABLE' }
  }
  const wanted = { slug: target.model, displayName: entry?.displayName ?? null }
  const hits = picker.rows.filter((row) => row.name !== 'All models' && names(row, wanted))
  if (hits.length !== 1 || !codexDigitPressable(hits[0].number)) return { error: 'MODEL_UNAVAILABLE' }
  const [row] = hits
  // The other models this list could show: the listed auto presets in the quick menu, the listed
  // ordinary models in the full one.
  const rivals = catalog.filter((model) => model.slug !== target.model && model.listed && isCodexAutoModel(model.slug) === quick)
  if (rivals.some((model) => names(row, model))) return { error: 'MODEL_UNAVAILABLE' }
  if (!entry) return { row, opens: 'unknown' }
  const effort = appliedAtOnce(entry, quick)
  if (effort === null) return { row, opens: 'efforts' }
  // Applied at once with its one effort: any other effort would be the wrong one, saved as the default.
  if (target.effort !== 'auto' && target.effort !== effort) return { error: 'EFFORT_UNSUPPORTED' }
  return { row, opens: 'applied', effort }
}
