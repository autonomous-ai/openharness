/**
 * Prime Agent model catalog + thinking level → runtime-profile options.
 *
 * Prime Agent is Pi's fork (engines/README.md, "When your agent is a FORK"): the structure below is Pi's,
 * every value was measured again on prime-agent 0.9.5 (2026-10-18, `cli/.probe/NOTES.md`).
 *
 * `prime-agent model list` prints Pi's fixed-width table (columns separated by runs of spaces):
 *
 *   provider      model            context  max-out  thinking  images
 *   anthropic     claude-opus-5-5  1M       128K     yes       yes
 *
 * What differs from Pi, and fails silently if inherited:
 *  - **The footer.** Pi draws `minimax/minimax-m3 • high`. Prime draws
 *    `← manage   claude-opus-5-5:high · 9.7k (1%)` — `<model>:<level> · <tokens> (<pct>%)`, and the model is
 *    the catalog's `model` column with NO provider.
 *  - **The model id.** The same model column exists under several providers in Prime's selector
 *    (`claude-opus-5` under anthropic, openrouter, github-copilot …), and `/model <bare id>` opens an
 *    autocomplete whose top row can be another provider's. So a profile's model is the catalog id
 *    `<provider>/<model>`, which `/model` takes exactly; the transcript's `model_change {provider, modelId}`
 *    names it the same way.
 *  - **The thinking level.** Pi has no command for it (a `/settings` ladder). Prime has
 *    `/effort <level>`, answered in the pane with `Thinking level: <level>`, or
 *    `⚠ Error: Unknown thinking level 'max'. Available: off, …, xhigh` when the model's ladder is shorter.
 *    `/effort` with no argument opens the same ladder as a list (`› high        Deep reasoning`).
 *  - **The ladder is per model.** gpt-5.4-mini stops at `xhigh`; the catalog does not say so (its
 *    `thinking` column is only yes/no), so every level is offered and the pane's error refuses it.
 *
 * Both `/model` and `/effort` also rewrite the user's global defaults in `<agent dir>/settings.json`
 * (`defaultProvider`, `defaultModel`, `recentModels`, `defaultThinkingLevel`) — see runtimeControl.ts.
 */

/** Prime's thinking ladder, in the order `/effort` lists it (`prime-agent --help`, and the pane's error). */
export const PRIME_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const PRIME_EFFORTS = new Set<string>(['auto', ...PRIME_THINKING_LEVELS])

export interface PrimeModelTarget {
  /** `<provider>/<model>` — the profile's model, and the exact argument for `/model`. */
  id: string
  provider: string
  /** The model column verbatim, as the footer shows it; it can itself contain a slash. */
  model: string
  /** True when the `thinking` column says `yes`; only then are effort rows offered. */
  thinking: boolean
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const plain = (text: string): string => text.replace(ANSI_RE, '')

const HEADER_RE = /^\s*provider\s+model\s/i

/**
 * Parse `prime-agent model list`. The header row and anything without at least the provider, model and
 * thinking columns are skipped, so a warning line or a future column cannot invent a model.
 */
export function parsePrimeModelsOutput(output: string): PrimeModelTarget[] {
  const targets: PrimeModelTarget[] = []
  const seen = new Set<string>()
  for (const rawLine of plain(output).split('\n')) {
    if (!rawLine.trim() || HEADER_RE.test(rawLine)) continue
    const cells = rawLine.trim().split(/\s{2,}/)
    if (cells.length < 5) continue
    const [provider, model] = cells
    if (!/^[\w.-]+$/.test(provider) || !model || /\s/.test(model)) continue
    // `thinking` is the second-to-last column (`images` closes the row).
    const thinking = /^yes$/i.test(cells[cells.length - 2] ?? '')
    const id = `${provider}/${model}`
    if (seen.has(id)) continue
    seen.add(id)
    targets.push({ id, provider, model, thinking })
  }
  return targets
}

/** `claude-opus-5-5:high · 9.7k (1%)` at the end of the footer line. Greedy model: `x:free:high` is `x:free`. */
const FOOTER_RE = /(?:^|\s)(\S+):([a-z]+)\s+·\s+\S+\s+\(\d+(?:\.\d+)?%\)\s*$/i

/**
 * Model (bare, as the footer prints it) + thinking level out of Prime's footer
 * (`← manage   claude-opus-5-5:high · 9.7k (1%)`). Null rather than a half-read pair, so a redraw
 * mid-capture can never be mistaken for a profile change. The caller maps the bare model onto a catalog id.
 */
export function parsePrimeFooterProfile(capture: string): { model: string; effort: string } | null {
  const lines = plain(capture).split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = FOOTER_RE.exec(lines[i].replace(/\s+$/, ''))
    if (!match) continue
    const effort = match[2].toLowerCase()
    if (!PRIME_EFFORTS.has(effort) || effort === 'auto') continue
    return { model: match[1], effort }
  }
  return null
}

/**
 * Steps along Prime's ladder from one level to another: positive means Down in the `/effort` list. Null
 * when either end is not on the ladder. The switch itself uses `/effort <level>`; this is kept for the
 * list, which `/effort` alone opens, so a driver never has to walk it blind.
 */
export function primeThinkingSteps(from: string, to: string): number | null {
  const start = PRIME_THINKING_LEVELS.indexOf(from as typeof PRIME_THINKING_LEVELS[number])
  const end = PRIME_THINKING_LEVELS.indexOf(to as typeof PRIME_THINKING_LEVELS[number])
  if (start < 0 || end < 0) return null
  return end - start
}

/**
 * The level Prime marks as current in the list `/effort` opens (`› high        Deep reasoning`). The
 * description is required: the slash-command autocomplete draws `› medium   Moderate reasoning` too, but
 * that row is a completion, not the current level — so a row is only read inside the ladder, which lists
 * at least two of the levels.
 */
export function parsePrimeThinkingSelection(capture: string): string | null {
  const lines = plain(capture).split('\n')
  const rows = lines.map((line) => /^\s*(›)?\s+([a-z]+)\s{2,}\S/i.exec(line))
  const ladder = rows.filter((row) => row && PRIME_THINKING_LEVELS.includes(row[2].toLowerCase() as typeof PRIME_THINKING_LEVELS[number]))
  if (ladder.length < 2) return null
  for (const row of ladder) {
    if (row?.[1]) return row[2].toLowerCase()
  }
  return null
}
