import { stoppedGoal } from './stoppedGoal.js'
import { activity } from './activity.js'
import type { EngineScreen, PaneTakeover, PaneView } from '../facets/screen.js'
import { inspectPane, paneModal as readModal, stripAnsi } from '../kit/pane.js'
import { locateQuestionPane } from '../kit/questionPane.js'
import { assembleScreen } from '../kit/screen.js'
import { composerState } from './composer.js'

export function questionPane(capture: string): PaneView {
  const found = locateQuestionPane(capture)
  if (!found || composerState(capture.split('\n').slice(found.at + 1).join('\n')) !== 'absent') return null
  return withCodexLabels(found.view)
}
export const inspectRuntimePane = (capture: string) => inspectPane('codex', capture, takeover, /\bplan mode\b/i)
export const paneModal = (capture: string) => readModal('codex', capture, takeover)
export const screen: EngineScreen = {
  inspect(capture) {
    const pane = inspectRuntimePane(capture)
    return assembleScreen('codex', capture, pane, questionPane(capture), paneModal(capture),
      composerState(capture), activity(capture), stoppedGoal(capture, pane))
  },
}

function withCodexLabels(view: PaneView): PaneView {
  if (!view || view.kind !== 'question') return view
  return {
    ...view,
    rows: view.rows.map((r) => ({ ...r, label: r.label.split(/\s{2,}/)[0].trim() || r.label })),
  }
}

/**
 * The key that dismisses Codex's update prompt without updating, or null unless the capture is exactly that prompt. Only
 * for the Swarm's agents (superTabs/terminal.ts), who must not wait for a person. It is Esc alone, never a row number and
 * Enter: on codex-cli 0.165.0 `0` is ignored and its Enter runs `brew upgrade` on the highlighted "Update now" (measured
 * 2026-10-29, update_prompt.rs the same in 0.164), so a Skip row misread as 0 or 1 would have updated Codex. Esc is what
 * the prompt's own footer says skips it; the capture must show that footer and exactly these three rows in this order,
 * so a misread or changed menu sends nothing and is left to the Lead.
 */
export function updateDismissKeys(capture: string): string[] | null {
  if (takeover(capture, '') !== 'update') return null
  const lines = stripAnsi(capture).replace(/\u00a0/g, ' ').split('\n').map(line => line.trim()).filter(Boolean)
  const header = lines.filter(line => /^Update available\b/.test(line))
  if (header.length !== 1) return null
  const rows = lines.filter(line => /^[›>]?\s*\d+\./.test(line)).map(line => line.replace(/^[›>]?\s*/, ''))
  const menu = rows.length === 3 && /^1\. Update now \(runs /.test(rows[0]) && rows[1] === '2. Skip' && rows[2] === '3. Skip until next version'
  const footer = /^enter\s+continue\s+·\s+esc\s+skip$/.test(lines[lines.length - 1])
  return menu && footer ? ['Escape'] : null
}

function takeover(capture: string, currentUi: string): PaneTakeover | null {
  const lines = stripAnsi(capture).replace(/\u00a0/g, ' ').split('\n')
  const bottom = lines.filter(line => line.trim()).slice(-3)
  const composer = lines.findLastIndex(line => /^\s*›/.test(line) && !/^\s*›\s*\d+\.\s/.test(line))
  const shown = (...patterns: RegExp[]) => patterns.every(pattern => lines.findLastIndex(line => pattern.test(line)) > composer)
  if (CODEX_TRANSCRIPT_BROWSING.test(currentUi)) return 'rewind'
  if (CODEX_PAGER_HEADER.test(lines.find((line) => line.trim()) ?? '')) return 'transcript'
  if (bottom.some((line) => CODEX_SEARCH_FOOTER.test(line))) return 'search'
  if (shown(CODEX_TRUST_QUESTION, CODEX_TRUST_ROW)) return 'trust'
  if (shown(/^\s*Update available\b/, CODEX_UPDATE_ROW)) return 'update'
  if (shown(/^\s*[›>]?\s*1\. Try new model\s*$/, /^\s*[›>]?\s*2\. Use existing model\s*$/)) return 'model'
  if (shown(/^\s*[›>]?\s*1\. Sign in with ChatGPT\s*$/)) return 'sign_in'
  return null
}
/** The header of Codex's pager over the whole pane, its top row: its transcript (ctrl+t) when it is not
 *  on the composer's screen (pager_overlay/transcript.rs). Closed with q or ctrl+t; Esc browses prompts. */
const CODEX_PAGER_HEADER = /^\/ T R A N S C R I P T(?: \/)*\s*$/

/** Codex's search footers: through its prompt history (`reverse-i-search: … enter accept · esc cancel`,
 *  chat_composer/history_search.rs) and through its transcript (`Find: …`, transcript_view/search.rs). */
const CODEX_SEARCH_FOOTER = /^\s*(?:reverse-i-search:|Find: )/

/** Codex's trust question, as 0.160 words it (onboarding/trust_directory.rs) and as 0.147 did. */
const CODEX_TRUST_QUESTION = /Trust this folder\? Codex can read, edit, and run files here|Do you trust the contents of this directory\?/
const CODEX_TRUST_ROW = /^\s*[›>]?\s*1\. (?:Trust and continue|Yes, continue|Open restricted|Open existing task)\s*$/

/** Codex's update prompt (update_prompt.rs): its first row runs the update. */
const CODEX_UPDATE_ROW = /^\s*[›>]?\s*1\. Update now \(runs /

const CODEX_TRANSCRIPT_BROWSING = /^\s*Browsing(?: transcript)?(?:\s+·|\s*$)/m

