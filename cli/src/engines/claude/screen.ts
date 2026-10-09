import { activity } from './activity.js'
import type { EngineScreen, PaneTakeover, PaneView } from '../facets/screen.js'
import { inspectPane, paneModal as readModal, stripAnsi } from '../kit/pane.js'
import { locateQuestionPane } from '../kit/questionPane.js'
import { assembleScreen } from '../kit/screen.js'
import { composerState } from './composer.js'

export function questionPane(capture: string): PaneView {
  const found = locateQuestionPane(capture)
  if (!found || composerState(capture.split('\n').slice(found.at + 1).join('\n')) !== 'absent') return null
  return found.view
}
export const inspectRuntimePane = (capture: string) => inspectPane('claude', capture, takeover)
export const paneModal = (capture: string) => readModal('claude', capture, takeover)
export const screen: EngineScreen = {
  inspect: capture => assembleScreen('claude', capture, inspectRuntimePane(capture), questionPane(capture),
    paneModal(capture), composerState(capture), activity(capture)),
}

function takeover(capture: string): PaneTakeover | null {
  const lines = stripAnsi(capture).replace(/\u00a0/g, ' ').split('\n')
  const bottom = lines.filter(line => line.trim()).slice(-3)
  const composer = lines.findLastIndex((line, index) => /^\s*❯/.test(line) && index > 0 && /^\s*[─━]{8,}\s*$/.test(lines[index - 1]))
  const shown = (...patterns: RegExp[]) => patterns.every(pattern => lines.findLastIndex(line => pattern.test(line)) > composer)
  if (claudeRewindMenuOpen(capture)) return 'rewind'
  if (bottom.some((line) => CLAUDE_TRANSCRIPT_FOOTER.test(line))) return 'transcript'
  if (bottom.some((line) => CLAUDE_HISTORY_SEARCH.test(line))) return 'search'
  if (shown(/Quick safety check: Is this a project you created or one you trust\?/, /^\s*(?:❯\s*)?Yes, I trust this folder\s*$/)) return 'trust'
  if (shown(/^\s*Select login method:\s*$/, /^\s*(?:❯\s*)?1\. Claude account with subscription\b/)) return 'sign_in'
  return null
}
/**
 * Claude Code's transcript view (ctrl+o): the prompt is hidden, and the footer row starts
 * `Showing detailed transcript · ctrl+o to toggle`, after `dialog waiting · ` when a dialog sits behind
 * it (2.1.289). It has no Enter, so a message typed there is lost. Esc, q or ctrl+c close it.
 */
const CLAUDE_TRANSCRIPT_FOOTER = /^\s*(?:dialog waiting · )?Showing detailed transcript\b/

/** Claude Code's prompt-history search (ctrl+r), under the prompt: `search prompts: <query>`, or
 *  `no matching prompt: <query>` (2.1.289). */
const CLAUDE_HISTORY_SEARCH = /^\s*(?:search prompts|no matching prompt): /

const CLAUDE_REWIND_BODY = /^(?:Restore the code\b|Restore and fork\b|Confirm you want to restore\b|Nothing to rewind to\b)/

function claudeRewindMenuOpen(capture: string): boolean {
  const lines = stripAnsi(capture).replace(/\u00a0/g, ' ').split('\n').map((line) => line.trim())
  // The title, with its body a blank line under it, and no rule after it: the prompt the menu hides
  // comes back between two rules once it closes.
  return lines.some((line, index) => line === 'Rewind'
    && lines.slice(index + 1, index + 4).some((next) => CLAUDE_REWIND_BODY.test(next))
    && !lines.slice(index + 1).some((next) => /[─━]{8,}/u.test(next)))
}

