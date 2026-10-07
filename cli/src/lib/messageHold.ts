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
 *   - a transcript view loses it (Claude Code's, ctrl+o; Codex's overlay, ctrl+t, in its scrollback
 *     mode);
 *   - a search takes it as what to search for, and Claude Code's prompt-history search then SENDS the
 *     earlier prompt it found (ctrl+r);
 *   - the questions asked at startup take the Enter as their highlighted answer: trust the folder
 *     (Claude Code's highlights `No, exit`, and quits), run Codex's update, switch Codex's model, start
 *     a sign-in.
 * So none of them is typed into. A question is answered through its own path (`question_response`),
 * never by a message.
 *
 * For Claude Code and Codex the screens above are named, to say what is open; anything else is typed
 * into only when the engine's own composer is on screen (composerScreen.ts), so a screen never seen
 * before is refused, never typed into. Other engines are read for their questions and permission
 * prompts only.
 *
 * One function for every route a message takes to a pane, so that none can skip it (core/input.ts).
 */
import { engineLabel } from './agentNames.js'
import { isApprovalDialog, parseEngineQuestionPane } from './askQuestion.js'
import type { RegisteredSession } from './registry.js'
import { COMPOSER_ENGINES, composerState } from './composerScreen.js'
import { paneModal } from './runtimeProfileController.js'

/** Why a message was not typed, as the reason its delivery is refused with. */
export type MessageHold = 'permission_open' | 'question_open' | 'menu_open' | 'rewind_picker_open' | 'transcript_open'
  | 'search_open' | 'trust_open' | 'update_prompt_open' | 'model_prompt_open' | 'sign_in_open' | 'popup_open'
  | 'prompt_hidden' | 'screen_unreadable'

const HOLDS: ReadonlySet<string> = new Set<MessageHold>(['permission_open', 'question_open', 'menu_open', 'rewind_picker_open',
  'transcript_open', 'search_open', 'trust_open', 'update_prompt_open', 'model_prompt_open', 'sign_in_open', 'popup_open',
  'prompt_hidden', 'screen_unreadable'])

/**
 * The holds that can be passing: an engine still starting draws nothing yet, a redraw can be caught
 * between frames, a capture can fail once. A message waits a little for these to clear before it is
 * refused (sessionInput.ts), as it does for the pane's control lease.
 */
const PASSING: ReadonlySet<string> = new Set<MessageHold>(['prompt_hidden', 'screen_unreadable'])
export function passingHold(reason: string): boolean {
  return PASSING.has(reason)
}

/** The hold for each of the engines' own screens and modals (runtimeProfileController.ts `paneModal`). */
const MODAL_HOLDS: Record<NonNullable<ReturnType<typeof paneModal>>, MessageHold> = {
  rewind: 'rewind_picker_open', transcript: 'transcript_open', search: 'search_open', trust: 'trust_open',
  update: 'update_prompt_open', model: 'model_prompt_open', sign_in: 'sign_in_open', permission: 'permission_open', menu: 'menu_open',
}

/** What the pane shows that a message must not be typed into, or null when it can be typed. */
export function messageHold(engine: RegisteredSession['engine'], capture: string | null): MessageHold | null {
  const allowlisted = COMPOSER_ENGINES.has(engine)
  if (capture === null) return allowlisted ? 'screen_unreadable' : null
  const view = parseEngineQuestionPane(engine, capture)
  if (view) return view.kind === 'question' && isApprovalDialog(view) ? 'permission_open' : 'question_open'
  if (!allowlisted) return null
  const modal = paneModal(engine, capture)
  if (modal) return MODAL_HOLDS[modal]
  const composer = composerState(engine, capture)
  return composer === 'ready' ? null : composer === 'popup' ? 'popup_open' : 'prompt_hidden'
}

export function isMessageHold(reason: string): reason is MessageHold {
  return HOLDS.has(reason)
}

function engineName(engine: string): string {
  return engine === 'claude' ? 'Claude Code' : engineLabel(engine)
}

/**
 * What the person is told when their message was typed but its Enter not pressed: the engine opened
 * something between the two, which the Enter would have answered. The text waits in the composer.
 */
export function messageWithheldText(engine: string, hold: string): string {
  const name = engineName(engine)
  const [what, then] = hold === 'permission_open' ? ['asked for permission', 'Answer the request in the app or in its terminal']
    : hold === 'question_open' ? ['asked you a question', 'Answer the question in the app or in its terminal']
      : ['opened another screen', 'Finish what\'s on its screen in its terminal']
  return `${name} ${what} just as your message was typed, so it was not sent; it waits in ${name}'s prompt. ${then}, then press Enter in its terminal to send the message, or clear it there.`
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
      return engine === 'codex'
        ? 'Codex is showing its transcript (ctrl+t), where a message is not typed. Close it with q in its terminal, then send the message again.'
        : `${name} is showing its transcript (ctrl+o), where a message is not typed. Close it with Esc in its terminal, then send the message again.`
    case 'search_open':
      return engine === 'codex'
        ? 'Codex has a search open, where a message would become what it searches for. Close it with Esc in its terminal, then send the message again.'
        : `${name} is searching its prompt history (ctrl+r), where Enter would send an earlier prompt. Close it with ctrl+c in its terminal, then send the message again.`
    case 'trust_open':
      return `${name} is asking whether to trust this folder. Answer it in its terminal, then send the message again.`
    case 'update_prompt_open':
      return `${name} is asking whether to update. Answer it in its terminal, then send the message again.`
    case 'model_prompt_open':
      return `${name} is asking whether to switch to a new model. Answer it in its terminal, then send the message again.`
    case 'sign_in_open':
      return `${name} is asking how to sign in. Sign in in its terminal, then send the message again.`
    case 'popup_open':
      return `${name} message not sent. Close suggestions with Esc in its terminal, then retry.`
    case 'prompt_hidden':
      return `${name} isn't showing its prompt; finish what's on its screen in its terminal, then send the message again.`
    case 'screen_unreadable':
      return `${name}'s screen could not be read, so the message was not typed. Send it again in a moment.`
  }
}
