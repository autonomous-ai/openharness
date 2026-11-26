/**
 * OpenCode model catalog → runtime-profile options.
 *
 * `opencode models` prints one `provider/model` per line on stdout, and that is the whole catalog:
 *
 *   opencode/ling-3.0-flash-free
 *   opencode-go/kimi-k3
 *   vibe/minimax/minimax-m3
 *
 * OpenCode has **no effort axis** — every option is `@auto`, and the label is the model alone.
 *
 * Switching is a picker (`/models`), but unlike Command Code's it accepts typed input, which is what
 * makes it safe to drive: type a filter, and act only once the list has narrowed to exactly ONE row.
 * Never arrow blindly through it — that is what the Command Code revert (2026-07-30) was about.
 * The filter matches across the model AND provider columns, which is how two rows that share a model
 * name (`MiniMax-M3` on OpenCode Go vs `MiniMax M3 (vibe)` on Vibe Gateway) are told apart.
 */

export interface OpencodeModelTarget {
  /** `<provider>/<model>` exactly as `opencode models` prints it. */
  id: string
  provider: string
  model: string
  /** What the picker filter is fed: model words, then provider words to disambiguate. */
  filter: string
  /**
   * The model's words ALONE, for the render where the provider is not in the row to match against.
   *
   * OpenCode draws the provider into the row only when it needs to: with several providers connected
   * a row reads `Big Pickle OpenCode Zen  ·  Free`, but with one it is just `Big Pickle  ·  Free` and
   * the provider name appears only as the section heading above. Feeding [filter] to the second one
   * matches NOTHING — measured on a live picker: `big pickle opencode` returned an empty list where
   * `big pickle` returned the row. So the drive falls back to this, and the "exactly one row left"
   * rule does the disambiguating instead: if only one model answers to the name, there is no second
   * provider to confuse it with.
   */
  modelFilter: string
  /** As the picker and the footer name it ("DeepSeek V4.1 Flash Free"), where OpenCode's own list said. */
  name?: string
  /** Its variants, OpenCode's efforts (`low`, `high`, `max`), in OpenCode's order; empty for a model with none. */
  efforts?: string[]
}

export interface OpencodePickerRow {
  display: string
  provider: string
  /** OpenCode marks the running model with `●`. */
  current: boolean
}

function words(value: string): string {
  return value.replace(/[^a-z0-9.]+/gi, ' ').trim().toLowerCase()
}

function squash(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '').toLowerCase()
}

/**
 * One `provider/model` id as a picker target, or null when it is not that shape.
 *
 * Split out from [parseOpencodeModelsOutput] because a target is also needed for a model that
 * `opencode models` never printed: a grid's provider is declared in a config file this daemon writes
 * for ONE agent, so the grid's models exist in that pane's picker and nowhere else. The construction
 * is identical either way — which is the point of sharing it, since a filter built by a second rule
 * would drift from the one the picker was measured against.
 */
export function opencodeModelTarget(id: string): OpencodeModelTarget | null {
  const trimmed = id.trim()
  if (!/^[a-z0-9][\w.-]*\/[\w./-]+$/i.test(trimmed)) return null
  const slash = trimmed.indexOf('/')
  const provider = trimmed.slice(0, slash)
  const model = trimmed.slice(slash + 1)
  // The picker shows the model's LAST segment (`minimax/minimax-m3` renders as "MiniMax M3"), so the
  // filter is built from that plus the provider.
  const leaf = model.slice(model.lastIndexOf('/') + 1)
  return {
    id: trimmed,
    provider,
    model,
    filter: `${words(leaf)} ${words(provider)}`.trim(),
    modelFilter: words(leaf),
  }
}

/**
 * Parse OpenCode 2's own model list (`opencode api GET /api/model`): each model's name as the picker draws it and its
 * variants, which are its efforts — `opencode models` prints neither. A model switched off or retired is left out, as
 * the picker leaves it out; a variant id that is not a plain word is dropped rather than typed into a picker.
 */
export function parseOpencodeApiModels(output: string): OpencodeModelTarget[] {
  let parsed: unknown
  try { parsed = JSON.parse(output) } catch { return [] }
  const data = (parsed as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  const targets: OpencodeModelTarget[] = []
  const seen = new Set<string>()
  for (const row of data.slice(0, 500)) {
    if (!row || typeof row !== 'object') continue
    const { id, providerID, name, variants, enabled, status } = row as Record<string, unknown>
    if (typeof id !== 'string' || typeof providerID !== 'string' || enabled === false || (status && status !== 'active')) continue
    const target = opencodeModelTarget(`${providerID}/${id}`)
    if (!target || seen.has(target.id)) continue
    seen.add(target.id)
    const label = typeof name === 'string' && name.trim() && name.length <= 128 ? name.trim() : null
    const efforts = Array.isArray(variants)
      ? variants.map((v) => (v as { id?: unknown })?.id).filter((v): v is string => typeof v === 'string' && /^[a-z][a-z0-9_-]{0,15}$/.test(v))
      : []
    targets.push({
      ...target,
      // The picker filters on what it draws: the model's name, not its id's words.
      ...(label ? { name: label, filter: `${words(label)} ${words(target.provider)}`.trim(), modelFilter: words(label) } : {}),
      efforts,
    })
  }
  return targets
}

/** Parse `opencode models`; anything that is not a `provider/model` line is ignored. */
export function parseOpencodeModelsOutput(output: string): OpencodeModelTarget[] {
  const targets: OpencodeModelTarget[] = []
  const seen = new Set<string>()
  for (const rawLine of output.split('\n')) {
    const target = opencodeModelTarget(rawLine)
    if (!target || seen.has(target.id)) continue
    seen.add(target.id)
    targets.push(target)
  }
  return targets
}

/**
 * Rows currently listed by the `/models` picker. The list is bounded above by its own header and below by
 * the "Connect provider" hint; reading only between them keeps the composer and the banner out.
 */
export function parseOpencodePickerRows(capture: string): OpencodePickerRow[] | null {
  const lines = capture.split('\n').map((line) => line.replace(/\s+$/, ''))
  // LAST header, not the first: a capture carries scrollback, so an earlier opening of the same picker is
  // usually still up there — reading from it parsed a stale, differently-filtered row set.
  const header = lines.findLastIndex((line) => SELECT_MODEL.test(line))
  const titled = lines.findLastIndex((line) => PICKER_TITLE.test(line) && !SELECT_MODEL.test(line) && !VARIANT_PICKER.test(line))
  if (titled > header) return opencode24Rows(lines, titled)
  if (header < 0) return null
  // OpenCode 2.2 ends the list with `View all integrations ctrl+a`, and draws its composer and the project's
  // `~/path   7.1K (4%)` column under it, which read as a second row (MSI, 2026-11-17).
  const below = lines.slice(header + 1)
  const last = below.findIndex((line) => /Connect provider|View all integrations|^\s*[┃╹]/i.test(line))
  const rows: OpencodePickerRow[] = []
  for (const line of below.slice(0, last < 0 ? below.length : last)) {
    const text = line.trim()
    if (!text) continue
    const current = text.startsWith('●')
    const cells = text.replace(/^●\s*/, '').split(/\s{3,}/).map((cell) => cell.trim()).filter(Boolean)
    // A model row is TWO cells — model and provider. Counting by position instead put the filter box
    // (one cell, the text just typed) in the row set, so a list narrowed to one model read as two rows
    // and every switch was refused. Provider group headings are single-cell too, and drop out here.
    if (cells.length < 2) continue
    rows.push({ display: cells[0], provider: cells[1], current })
  }
  return rows
}

/** OpenCode 2.2's `/models` picker, by its title. */
const SELECT_MODEL = /\bSelect model\s{2,}esc\b/
/**
 * OpenCode 2.4's, by its title, a line that ends in `esc`: `Free models` while only the free ones are there, and with a
 * provider connected the filter box itself, `Search models` until something is typed and then what was typed. Its last
 * line (`connect provider ctrl+a  favorite ctrl+f`) is no mark: on a phone's 50×20 it is wrapped or not drawn at all
 * (MSI, 2026-11-26).
 */
const PICKER_TITLE = /\S\s{2,}esc$/
const OPENED_24 = /\b(?:Free|Search) models\s{2,}esc\b/
/** The cursor's row of a 2.4 picker, edged `┃`, then the current one's `▪` or a space, then its name. */
const CURSOR_ROW = /┃ [▪● ] \S/

/**
 * A picker's lines under its title, from its own column on: OpenCode 2.4 draws its pickers over the conversation,
 * whose words share their lines (MSI, 2.4.1, 2026-11-26). The column starts where the cursor's `┃` edge is drawn,
 * four before the title.
 */
function pickerLines(lines: string[], header: number, title: RegExp): string[] {
  const column = Math.max(0, lines[header].search(title) - 4)
  return lines.slice(header + 1).map((line) => line.slice(column).replace(/\s+$/, ''))
}

/**
 * One row of an OpenCode 2.4 picker: the cursor's row is edged `┃` and the current one marked `▪` (2.2: `●`). Null for
 * the composer's own edge under a list, a bare `┃` or its `┃  Build · …` footer.
 */
function pickerRow(text: string): { text: string; current: boolean; cursor: boolean } | null {
  const edged = text.startsWith('┃')
  // The composer's edge, `┃  words`, is not the cursor's `┃ ▪ name` / `┃   name`.
  if (edged && !CURSOR_ROW.test(text)) return null
  const rest = text.replace(/^┃/, '').trim()
  const current = /^[▪●]/.test(rest)
  const name = rest.replace(/^[▪●]\s*/, '').trim()
  if (!name || (edged && name.includes('·'))) return null
  return { text: name, current, cursor: edged }
}

/**
 * The rows of OpenCode 2.4's `/models` picker titled at line [header], measured on MSI (2.4.1, 2026-11-26), its parts
 * apart by empty lines:
 *
 *   - only the free models: `Free models`, a note to connect a provider (two lines on a phone), the filter box, one
 *     model a row by its name, then the details of the row under the cursor (`Text · 262K · Reasoning`);
 *   - with a provider connected: the filter box as the title, rows of a model's name and its provider's
 *     (`Check Stub Harness Check`), under headings (`Recent`, the providers', `Free`) while nothing is typed.
 *
 * A row's provider is in `display` then, and `provider` is empty.
 */
function opencode24Rows(lines: string[], header: number): OpencodePickerRow[] {
  const after = lines.slice(header + 1)
  // Its column is the cursor's edge, four before its words; the title's line can carry the conversation's words before
  // it, and on a narrow screen the composer's edge is in the picker's own column.
  const cursor = after.map((line) => line.search(CURSOR_ROW)).find((at) => at >= 0)
  const title = lines[header].search(/\b(?:Free|Search) models\b/)
  const column = Math.max(0, cursor ?? (title >= 0 ? title : lines[header].search(/\S/)) - 4)
  const body = after.map((line) => line.slice(column).trim())
  let at = 0
  const skipEmpty = () => { while (at < body.length && !body[at]) at++ }
  if (/\bFree models\s{2,}esc$/.test(lines[header])) {
    skipEmpty()
    while (at < body.length && body[at]) at++ // the note, over one line or two
    skipEmpty()
    at++ // the filter box
  }
  skipEmpty()
  const rows: OpencodePickerRow[] = []
  for (const text of body.slice(at)) {
    if (!text || /^No results/i.test(text) || text.includes(' · ') || /\bconnect (?:integration|provider)\b|\bfavorite ctrl\+f/.test(text)) break
    const row = pickerRow(text)
    if (!row) break
    rows.push({ display: row.text, provider: '', current: row.current })
  }
  return rows
}

/**
 * How many times the `/models` picker appears in a capture. A tmux capture includes scrollback, so the
 * only way to tell "the picker I just opened" from "a picker I opened a minute ago" is that the count went
 * up — see setOpencode.
 */
export function countOpencodePickers(capture: string): number {
  return capture.split('\n').filter((line) => SELECT_MODEL.test(line) || OPENED_24.test(line)).length
}

/**
 * The rows of OpenCode 2's `/effort` picker, its variants, as drawn on MSI (2026-11-17):
 *
 *     Select variant                       esc
 *     Search                     ← the filter box: what is typed shows here
 *   ● Default
 *     low
 *     high
 *
 * OpenCode 2.4 draws it with no filter box: what is typed goes nowhere, and the arrows move a cursor, the row edged `┃`
 * (MSI, 2.4.1, 2026-11-26).
 *
 * Null when none is open. Bounded below by the composer's `┃`/`╹` edge.
 */
export function parseOpencodeVariantRows(capture: string): OpencodeVariantRow[] | null {
  const lines = capture.split('\n')
  const header = lines.findLastIndex((line) => VARIANT_PICKER.test(line))
  if (header < 0) return null
  const rows: OpencodeVariantRow[] = []
  // The first line under the title is the filter box. 2.4 draws the conversation on past the list, and the list has
  // no line between its last row and that: the first empty line ends it.
  for (const line of pickerLines(lines, header, /Select variant/).slice(1)) {
    const text = line.trim()
    if (/^╹/.test(text)) break
    if (!text) { if (rows.length) break; continue }
    if (/^No results/i.test(text)) continue
    const row = pickerRow(text)
    if (!row) break
    rows.push({ name: row.text, current: row.current, cursor: row.cursor })
  }
  return rows
}

/** A row of the `/effort` picker. `cursor`: the row under OpenCode 2.4's cursor, which Enter takes. */
export interface OpencodeVariantRow { name: string; current: boolean; cursor: boolean }

const VARIANT_PICKER = /\bSelect variant\s{2,}esc\b/

/** How many times the `/effort` picker appears in a capture: see [countOpencodePickers]. */
export function countOpencodeVariantPickers(capture: string): number {
  return capture.split('\n').filter((line) => VARIANT_PICKER.test(line)).length
}

/** True when a picker row NAMES the target's model, whatever provider it is listed under. */
export function opencodeRowNamesModel(target: OpencodeModelTarget, row: OpencodePickerRow): boolean {
  const leaf = target.model.slice(target.model.lastIndexOf('/') + 1)
  // By its id's words or by its name: a provider's own model can be named apart from its id (`stub`, `Check Stub`).
  return [leaf, target.name].some((key) => !!key && squash(row.display).startsWith(squash(key)))
}

/** True when a picker row is the catalog entry we are trying to select. */
export function opencodeRowMatches(target: OpencodeModelTarget, row: OpencodePickerRow): boolean {
  return opencodeRowNamesModel(target, row)
    && squash(`${row.display} ${row.provider}`).includes(squash(target.provider))
}

/**
 * Resolve OpenCode's footer (`Build · MiniMax M3 (vibe) Vibe Gateway (Minimax)`) back to a catalog id.
 * Both halves are needed: the model name alone is ambiguous across providers, and the provider alone
 * cannot name a model. The longest model match wins so `MiMo V2.5 Pro` never resolves to `mimo-v2.5`.
 */
/** What OpenCode's composer footer says is running. */
export interface OpencodeFooter {
  /** Model and provider as printed, e.g. `Ox Alpha Free (Unlimited) OpenCode Zen`. */
  target: string
  /** The reasoning level, when the build prints one. */
  effort: string | null
}

/**
 * Read the composer footer: `Build · <model> <provider>` and, on builds that have a reasoning axis,
 * `· <effort>` after it.
 *
 *   Build · MiniMax M3 (vibe) Vibe Gateway
 *   Build · Ox Alpha Free (Unlimited) OpenCode Zen · high
 *
 * Split on the separator rather than taking everything after the FIRST one, which is what this used
 * to do: on a build that prints an effort, the level was swallowed into the model text, so the
 * catalog was searched for "…OpenCode Zen high" and the level itself was thrown away.
 */
export function parseOpencodeFooter(capture: string): OpencodeFooter | null {
  const line = capture.split('\n').map((l) => l.trim()).reverse()
    .find((l) => /·/.test(l) && /\b(Build|Plan)\b/i.test(l))
  if (!line) return null
  // [0] is the mode (Build/Plan) and is not ours to report; the chips show model and effort.
  const parts = line.split('·').map((part) => part.trim()).filter(Boolean)
  if (parts.length < 2) return null
  // Wide panes put the project path in a separate, padded column.
  const target = parts[1].split(/\s{3,}/)[0].trim()
  if (!target) return null
  const trailing = parts[2]?.toLowerCase() ?? null
  // Only a single bare word is treated as a level. Anything longer is part of the name of something,
  // and inventing an effort out of it would put a wrong value on the chip rather than no value.
  const effort = trailing && /^[a-z][a-z-]*$/.test(trailing) ? trailing : null
  return { target, effort }
}

/**
 * The catalog entry the footer names, or null when the footer names something the catalog does not
 * list — which happens for real: with no provider connected, OpenCode runs a built-in free model
 * that `opencode models` does not print. Callers that only want to SHOW what is running should read
 * [parseOpencodeFooter] instead; this answers the narrower question of which switchable option it is.
 */
export function opencodeFooterModelId(capture: string, catalog: OpencodeModelTarget[]): string | null {
  const footer = parseOpencodeFooter(capture)
  if (!footer) return null
  // OpenCode 2.2 on a phone's 50 columns: `Build · DeepSeek V4.1 Flash F… · high`, and with one provider connected no
  // provider after the name at all (`Build · DeepSeek V4.1 Flash Free`), measured on MSI 2026-11-17.
  const cut = footer.target.endsWith('…')
  const tail = squash(footer.target.replace(/…$/, ''))
  if (!tail) return null

  // The provider named after the model tells two same-named models apart; a name cut short must name one model only.
  let best: { id: string; score: number } | null = null
  let tied = false
  for (const entry of catalog) {
    const keys = [entry.name, entry.model.slice(entry.model.lastIndexOf('/') + 1)].map((key) => squash(key ?? '')).filter(Boolean)
    for (const key of keys) {
      const whole = tail.startsWith(key)
      if (!whole && !(cut && key.startsWith(tail))) continue
      // Words after the name are its provider's, and must be this entry's: `MiniMax M3 (vibe) Vibe Gateway` is not
      // opencode-go's MiniMax M3. Nothing after it is a footer that names no provider.
      const rest = whole ? tail.slice(key.length) : ''
      const named = !!rest && rest.includes(squash(entry.provider))
      if (rest && !named) continue
      const score = (named ? 1000 : 0) + (whole ? key.length : tail.length)
      if (best && best.id !== entry.id && score === best.score) tied = true
      if (!best || score > best.score) { best = { id: entry.id, score }; tied = false }
    }
  }
  return best && !tied ? best.id : null
}
