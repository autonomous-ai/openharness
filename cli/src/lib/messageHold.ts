/**
 * Whether a message can be typed into an agent's pane as it stands, and if not, why not and what the
 * person can do about it.
 *
 * A message is a bracketed paste followed by Enter. Typed into the composer, that sends it. Typed into
 * a dialog, it does something else: the dialogs below drop the paste, and the Enter confirms what is
 * highlighted. Read from the engines' own code (Claude Code 2.1.289's bundle, Codex 0.160's tui/src):
 *   - a permission prompt approves its highlighted row, the first: Yes, run it (Claude Code's Select has
 *     no paste handler; Codex's ApprovalOverlay leaves `handle_paste` to its default, and its own test
 *     `enter_sets_last_selected_index_without_dismissing` expects Accept);
 *   - a question picks its highlighted option (Claude Code), or takes the paste as notes on it and
 *     submits that (Codex's request_user_input);
 *   - a menu (model, effort and the other pickers) picks its highlighted row;
 *   - a picker for a point to rewind to rewinds, or loses the message (Codex's transcript browser,
 *     Claude Code's Rewind menu);
 *   - Claude Code's transcript view (ctrl+o) loses it.
 * So none of them is typed into. A question is answered through its own path (`question_response`),
 * never by a message.
 *
 * One function for every route a message takes to a pane, so that none can skip it (core/input.ts).
 */
import { engineLabel } from './agentNames.js'
import { isApprovalDialog, parseEngineQuestionPane } from './askQuestion.js'
import type { RegisteredSession } from './registry.js'
import { paneModal } from './runtimeProfileController.js'

/** Why a message was not typed, as the reason its delivery is refused with. */
export type MessageHold = 'permission_open' | 'question_open' | 'menu_open' | 'rewind_picker_open' | 'transcript_open'

const HOLDS: ReadonlySet<string> = new Set<MessageHold>(['permission_open', 'question_open', 'menu_open', 'rewind_picker_open', 'transcript_open'])

/** The engines whose screens are read for more than a question: the menus, rewind pickers and views. */
const MODAL_ENGINES: ReadonlySet<string> = new Set(['claude', 'codex'])

/**
 * Claude Code's transcript view (ctrl+o): the prompt is hidden, and the footer row starts
 * `Showing detailed transcript · ctrl+o to toggle`, after `dialog waiting · ` when a dialog sits behind
 * it (2.1.289). It has no Enter, so a message typed there is lost. Esc, q or ctrl+c close it.
 */
const CLAUDE_TRANSCRIPT_FOOTER = /^\s*(?:dialog waiting · )?Showing detailed transcript\b/

function claudeTranscriptOpen(capture: string): boolean {
  const lines = capture.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\n').filter((line) => line.trim())
  return lines.slice(-3).some((line) => CLAUDE_TRANSCRIPT_FOOTER.test(line))
}

/** What the pane shows that a message must not be typed into, or null when it can be typed. */
export function messageHold(engine: RegisteredSession['engine'], capture: string | null): MessageHold | null {
  if (!capture) return null
  const view = parseEngineQuestionPane(engine, capture)
  if (view) return view.kind === 'question' && isApprovalDialog(view) ? 'permission_open' : 'question_open'
  if (!MODAL_ENGINES.has(engine)) return null
  if (engine === 'claude' && claudeTranscriptOpen(capture)) return 'transcript_open'
  const modal = paneModal(engine, capture)
  return modal === 'rewind' ? 'rewind_picker_open' : modal === 'permission' ? 'permission_open' : modal === 'menu' ? 'menu_open' : null
}

export function isMessageHold(reason: string): reason is MessageHold {
  return HOLDS.has(reason)
}

function engineName(engine: string): string {
  return engine === 'claude' ? 'Claude Code' : engineLabel(engine)
}

/** What the person is told: why their message was not typed, and what lets it through. */
export function messageHoldText(engine: string, hold: MessageHold): string {
  const name = engineName(engine)
  switch (hold) {
    case 'permission_open':
      return `${name} is asking for ${engine === 'codex' ? 'approval' : 'permission'}. Answer it first, in the app or in its terminal, then send the message again.`
    case 'question_open':
      return `${name} is asking you a question. Answer it first, in the app or in its terminal, then send the message again.`
    case 'menu_open':
      return `${name} has a menu open, where Enter would pick from it. Close it with Esc in its terminal, then send the message again.`
    case 'rewind_picker_open':
      return engine === 'codex'
        ? 'Codex is browsing its transcript, where Enter would rewind the conversation. Close it with Esc in its terminal, then send the message again.'
        : `${name} has its Rewind menu open, where Enter would pick a point to rewind to. Close it with Esc in its terminal, then send the message again.`
    case 'transcript_open':
      return `${name} is showing its transcript (ctrl+o), where a message is not typed. Close it with Esc in its terminal, then send the message again.`
  }
}
