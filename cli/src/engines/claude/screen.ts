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
  // Whether to trust the MCP servers of a `.mcp.json` the folder brings (one, or several to pick from; 2.1.310): its
  // highlighted `❯ Continue without using this MCP server` was read as a draft in the composer, and `harness wait`
  // waited on it as on an agent about to work (2026-10-26). It is the person's to answer, as the folder's trust is.
  if (shown(/New MCP servers? found in this project/i, /^\s*(?:❯\s*)?Continue without using this MCP server\s*$/)
    || shown(/new MCP servers found in this project/i, /Select any you wish to enable/i)) return 'trust'
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


/**
 * The key that closes one of Claude Code's own feedback popups without sending anything, or null unless the capture shows
 * exactly one of them. Only for the Swarm's agents (superTabs/terminal.ts), whom nobody watches: a "Bug report drafted"
 * popup about the Lead's own slip covered its prompt, and every message to it came back undelivered (`prompt_hidden`,
 * Nova in the Swarm autonomous-harness, 2026-10-29). As measured there (Claude Code 2.1, 2026-10-29):
 * - "Bug report drafted: …" with "1 to review · 2 to send · 0 to dismiss": `0` dismisses the draft; nothing is sent.
 * - Then "Turn off Claude-drafted feedback? 0 to turn off · Esc to keep": Esc, so the person's setting stays as it was.
 * - "How is Claude doing this session?" with "0: Dismiss": `0`, no rating given.
 * A popup that reads otherwise, or two at once, gets nothing and stays the Lead's to see.
 */
export function feedbackDismissKeys(capture: string): string[] | null {
  const lines = stripAnsi(capture).replace(/\u00a0/g, ' ').split('\n').map(line => line.replace(/^[\s│|]+|[\s│|]+$/g, ''))
  const count = (pattern: RegExp) => lines.filter(line => pattern.test(line)).length
  const draft = count(/^✻?\s*Bug report drafted:/) === 1 && count(/^1 to review · 2 to send · 0 to dismiss$/) === 1
  const turnOff = count(/^Turn off Claude-drafted feedback\? 0 to turn off · Esc to keep$/) === 1
  const survey = count(/How is Claude doing this session\?/) === 1 && count(/^1: Bad\s+2: Fine\s+3: Good\s+0: Dismiss$/) === 1
  if (Number(draft) + Number(turnOff) + Number(survey) !== 1) return null
  return turnOff ? ['Escape'] : ['0']
}
