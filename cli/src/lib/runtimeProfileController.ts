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
  chooseCodexRow,
  codexDigitPressable,
  codexEffortRows,
  parseCodexPicker,
  sameCodexPicker,
  type CodexCatalogModel,
  type CodexPicker,
} from '../engines/codex/modelPicker.js'
import {
  codexEffortAllowed,
  parseRuntimeProfile,
  supportsNativeRuntimeControl,
  type CursorModelTarget,
  type RuntimeProfile,
  type RuntimeProfileManager,
} from './runtimeProfile.js'

const COMMAND_CONFIRM_MS = 8_000
const PICKER_OPEN_MS = 3_000
const PICKER_STEP_MS = 2_000
/**
 * How far apart the two reads of a Codex model list are, which must agree before a digit is pressed on
 * it (see reachCodexEfforts): long enough for a redraw in flight to land, short beside the seconds a
 * switch takes to confirm.
 */
const CODEX_SETTLE_MS = 250
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

export type RuntimeProfileErrorCode =
  | 'AGENT_NOT_FOUND'
  | 'INVALID_RUNTIME_PROFILE'
  | 'BUSY'
  | 'UNSUPPORTED_CLI_VERSION'
  | 'MODEL_UNAVAILABLE'
  | 'EFFORT_UNSUPPORTED'
  | 'PLAN_SCOPE_AMBIGUOUS'
  | 'CONFIRM_TIMEOUT'
  | 'TMUX_FAILED'

export class RuntimeProfileControlError extends Error {
  constructor(readonly code: RuntimeProfileErrorCode) {
    super(code)
  }
}

export interface PaneInspection {
  idle: boolean
  plan: boolean
  dialog: boolean
  draft: boolean
}

export interface RuntimeProfileControllerDeps {
  manager: RuntimeProfileManager
  getSession: (sessionId: string) => RegisteredSession | undefined
  validateRuntime: (session: RegisteredSession) => Promise<boolean>
  capture: (terminalTarget: string, historyLines?: number) => Promise<string | null>
  sendText: (terminalTarget: string, text: string) => Promise<boolean>
  /** Type without submitting. */
  sendLiteral: (terminalTarget: string, text: string) => Promise<boolean>
  sendKey: (terminalTarget: string, key: string) => Promise<boolean>
  acquireInput: (sessionId: string) => (() => void) | null
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;:]*[A-Za-z]/g, '')
}

/**
 * The SGR attributes an escape sequence actually sets, with extended-colour arguments removed.
 *
 * `38`/`48`/`58` introduce a colour whose ARGUMENTS are numbers, not attributes: `5;<n>` for 256 and
 * `2;<r>;<g>;<b>` for truecolor. Without this skip a truecolor foreground (`38;2;…`) reads as SGR 2
 * — dim — and a line the user had typed would be mistaken for an empty composer, which is the one
 * direction this must never be wrong in: the pane would read idle and be respawned under a draft.
 */
function sgrAttributes(params: readonly string[]): string[] {
  const attributes: string[] = []
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index]
    if (code !== '38' && code !== '48' && code !== '58') {
      attributes.push(code)
      continue
    }
    const kind = params[index + 1]
    index += kind === '5' ? 2 : kind === '2' ? 4 : 1
  }
  return attributes
}

/**
 * The background an SGR sequence sets, as a comparable string — or null if it sets none.
 *
 * Needed because a composer box is identified by the colour it PAINTS, and the parameters that
 * choose one are positional: `48;5;<n>` and `48;2;<r>;<g>;<b>` carry their arguments inline, so the
 * arguments have to be consumed rather than read as further attributes. `38`/`58` are skipped the
 * same way for the same reason — a truecolor FOREGROUND ends in numbers that would otherwise parse
 * as a background code of their own.
 *
 * SGR 0 counts: a reset puts the default background back, which is a change like any other.
 */
function sgrBackground(params: readonly string[]): string | null {
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index]
    if (code === '48') {
      const kind = params[index + 1]
      return params.slice(index, index + (kind === '5' ? 3 : kind === '2' ? 5 : 2)).join(';')
    }
    if (code === '49' || /^(?:4[0-7]|10[0-7])$/.test(code)) return code
    if (code === '0' || code === '') return '49'
    if (code === '38' || code === '58') {
      const kind = params[index + 1]
      index += kind === '5' ? 2 : kind === '2' ? 4 : 1
    }
  }
  return null
}

/**
 * The span of a gutter line the BOX ITSELF paints — everything after the marker was wrong.
 *
 * A TUI draws one row of the terminal at a time, so anything floating OVER the composer lands on the
 * composer's own lines. OpenCode's `Getting started` card is exactly that: a panel on the right-hand
 * side, and its rows are written after the composer's on the same lines. Reading to end-of-line took
 * the card's text as something the user had typed —
 *
 *   ┃ <121 spaces of composer>  <sidebar>  Connect provider        /connect
 *
 * so `draft` was true over an EMPTY composer, the pane never read idle, and every model switch came
 * back AGENT_BUSY. Measured on a live pane (`harness-opencode-*`, 2026-09-15) with nothing typed in.
 * Fourth variant of the family above: the marker is found, the strip is dropped, and then the wrong
 * COLUMNS are read.
 *
 * The boundary is the box's own background. Everything a box paints is painted in it, so the
 * interior runs from the background set right after the marker to the next background change — in
 * the capture above, back to the pane's `48;2;10;10;10` where the box ends and the sidebar begins.
 *
 * Two deliberate conservatisms, both pointing the same way — a real draft must never be read as an
 * empty prompt, because that respawns the engine under text the user typed:
 *   * A background that appears only AFTER visible text is not the interior's. It is a highlight
 *     drawn mid-draft, and treating it as the boundary would cut the draft off at its own styling.
 *   * A line that sets no background at all is not clipped. Plain-text panes (and every engine that
 *     paints no box) keep the whole line, exactly as before.
 */
function gutterBoxInterior(line: string, markerIndex: number): string {
  const after = line.slice(markerIndex + 1)
  const sgr = /\u001b\[([0-9;:]*)m/g
  let interior: string | null = null
  let end = after.length
  let match: RegExpExecArray | null
  while ((match = sgr.exec(after)) !== null) {
    const background = sgrBackground(match[1].split(/[;:]/))
    if (background === null) continue
    if (interior === null) {
      if (stripAnsi(after.slice(0, match.index)).trim().length > 0) break
      interior = background
      continue
    }
    if (background !== interior) { end = match.index; break }
  }
  return after.slice(0, end)
}

/**
 * Is the text after the composer marker the PLACEHOLDER, rather than something the user typed?
 *
 * Read from the STYLING, never the words: the placeholder sentence differs per engine and changes
 * between versions, but every one of these TUIs greys its placeholder out somehow and none of them
 * styles a draft the same way.
 *
 * Two attributes, because two are in use. SGR 2 (dim) is what claude, codex and devin draw; SGR 3
 * (italic) is what hermes draws — its `Ask anything, or type / for commands…` is italic over a
 * 256-colour gold (`ESC[3m ESC[38;5;136m`) and carries no dim at all. Looking only for dim made
 * EVERY hermes pane look like a pane with a draft in it, so `idle` was false for the agent's whole
 * life and every retarget and model switch came back AGENT_BUSY over an engine sitting at an empty
 * prompt. Same failure the comment on `promptMarker` warns about, one step further along: the
 * marker was found, and then the placeholder was not recognised as one.
 */
function hasPlaceholderSgr(value: string): boolean {
  return [...value.matchAll(/\u001b\[([0-9;:]*)m/g)]
    .some((match) => {
      const attributes = sgrAttributes(match[1].split(/[;:]/))
      return attributes.includes('2') || attributes.includes('3')
    })
}

/**
 * Is this SGR foreground a MUTED one — the grey a TUI writes hints and placeholders in?
 *
 * Returns null when the sequence sets no foreground, so a caller can keep the colour already in
 * effect rather than treating "no change" as a change.
 *
 * Grey is judged by the colour itself: equal channels, and dark enough to read as secondary next to
 * the near-white a composer draws real text in. OpenCode's placeholder is `38;2;128;128;128` and its
 * own text `38;2;255;255;255`; the 256-colour ramp (232–255) and SGR 90 are the same intent spelled
 * differently.
 */
function sgrMutedForeground(params: readonly string[]): boolean | null {
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index]
    if (code === '38') {
      const kind = params[index + 1]
      if (kind === '2') {
        const [r, g, b] = [params[index + 2], params[index + 3], params[index + 4]].map(Number)
        if (![r, g, b].every(Number.isFinite)) return null
        return r === g && g === b && r >= 0x40 && r <= 0xb0
      }
      if (kind === '5') {
        const n = Number(params[index + 2])
        if (!Number.isFinite(n)) return null
        // 8 is bright black; 232–255 is the grey ramp, whose middle is the secondary tone.
        return n === 8 || (n >= 236 && n <= 250)
      }
      return null
    }
    if (code === '90') return true
    if (code === '39' || code === '0' || code === '') return false
    if (/^(?:3[0-7]|9[1-7])$/.test(code)) return false
    if (code === '48' || code === '58') {
      const kind = params[index + 1]
      index += kind === '5' ? 2 : kind === '2' ? 4 : 1
    }
  }
  return null
}

/**
 * Is EVERY visible character here written in a muted colour — i.e. is this a hint rather than a draft?
 *
 * The third placeholder styling this module has had to learn, after dim (claude, codex, devin) and
 * italic (hermes). OpenCode draws `Ask anything… "What is the tech stack of this project?"` as a plain
 * TRUECOLOR GREY with no dim and no italic attribute at all, so [hasPlaceholderSgr] saw nothing and a
 * brand-new pane read as a pane with a draft in it: never idle, and every model switch on an agent
 * with no messages yet refused as AGENT_BUSY over an empty composer. Measured on 1.18.31.
 *
 * ⚠️ EVERY character, not any — which is what keeps this from swallowing a real draft. A composer
 * writes what the user typed in its normal near-white; one such character anywhere means this is
 * text, whatever grey hint may be sitting beside it. Spaces are not evidence of either and carry no
 * colour worth reading, so they are skipped.
 */
function allVisibleTextIsMuted(value: string): boolean {
  const sgr = /\u001b\[([0-9;:]*)m/g
  let muted: boolean | null = null
  let cursor = 0
  let sawText = false
  let match: RegExpExecArray | null
  const segment = (text: string): boolean => {
    if (!text.trim()) return true
    sawText = true
    return muted === true
  }
  while ((match = sgr.exec(value)) !== null) {
    if (!segment(value.slice(cursor, match.index))) return false
    const next = sgrMutedForeground(match[1].split(/[;:]/))
    if (next !== null) muted = next
    cursor = match.index + match[0].length
  }
  if (!segment(value.slice(cursor))) return false
  return sawText
}

/**
 * The glyph each CLI puts in front of its composer. They do not share one: cursor uses `→`, devin `❭`
 * (U+276D — close to, but not, claude's `❯` U+276F), and pi draws no marker at all. Getting this wrong is
 * not cosmetic — with no prompt found the pane never reads idle, and every switch is refused as BUSY.
 */
function promptMarker(engine: RegisteredSession['engine']): RegExp {
  if (engine === 'cursor') return /→/u
  if (engine === 'devin') return /[❭›❯]/u
  if (engine === 'opencode') return /┃/u
  return /[›❯]/u
}

export function inspectRuntimePane(engine: RegisteredSession['engine'], capture: string): PaneInspection {
  if (engine === 'pi') return inspectPiPane(capture)
  if (engine === 'opencode') return inspectGutterBoxPane(capture, true)
  if (engine === 'copilot') return inspectGutterBoxPane(capture, false)
  if (engine === 'grok') return inspectGrokPane(capture)
  const rawLines = capture.split('\n')
  const marks = promptMarker(engine)
  const promptIndex = latestPromptLine(rawLines, marks)
  const prompt = promptIndex >= 0 ? rawLines[promptIndex] : ''
  const currentUi = currentPaneUi(rawLines, promptIndex)
  const dialog = DIALOG_UI.test(currentUi) || takeoverIn(engine, capture, currentUi) !== null
  const plan = engine === 'codex' ? /\bplan mode\b/i.test(currentUi) : /\bplan mode on\b/i.test(currentUi)
  const marker = stripAnsi(prompt).search(marks)
  let visible = marker >= 0 ? stripAnsi(prompt).slice(marker + 1).replace(/\u00a0/g, ' ').trim() : ''
  const rawMarker = prompt.search(marks)
  const rawTail = rawMarker >= 0 ? prompt.slice(rawMarker + 1) : ''
  const placeholder = hasPlaceholderSgr(rawTail)
  if (placeholder) visible = ''
  const draft = visible.length > 0
  return { idle: !!prompt && !dialog && !draft, plan, dialog, draft }
}

/** The latest composer prompt line; picker rows use the same glyphs, but numbered rows are not prompts. */
function latestPromptLine(rawLines: string[], marks: RegExp): number {
  return rawLines.findLastIndex((line) => {
    const visible = stripAnsi(line)
    const marker = visible.search(marks)
    return marker >= 0 && !/^\s*\d+\.\s/.test(visible.slice(marker + 1))
  })
}

/**
 * Old picker/plan text can remain in tmux history. Only UI below the latest prompt belongs to the
 * current interaction; if no prompt is visible, inspect the whole capture as a conservative fallback.
 */
function currentPaneUi(rawLines: string[], promptIndex: number): string {
  return stripAnsi((promptIndex >= 0 ? rawLines.slice(promptIndex) : rawLines).join('\n')).replace(/\u00a0/g, ' ')
}

/** A screen of Claude Code's or Codex's own that takes its composer's place (see [takeoverIn]). */
export type PaneTakeover = 'rewind' | 'transcript' | 'search' | 'trust' | 'update' | 'model' | 'sign_in'

/**
 * The modal over a Claude Code or Codex pane, read for a message about to be typed into it
 * (messageHold.ts): one of their own screens that takes the composer's place ([takeoverIn]), an
 * approval prompt, or another menu. Every one of them is a dialog to [inspectRuntimePane], except the
 * MCP boot notice: Claude Code takes typing while it shows, so a message sent the moment an agent
 * starts still goes in.
 */
export function paneModal(engine: RegisteredSession['engine'], capture: string): PaneTakeover | 'permission' | 'menu' | null {
  const rawLines = capture.split('\n')
  const currentUi = currentPaneUi(rawLines, latestPromptLine(rawLines, promptMarker(engine)))
  const takeover = takeoverIn(engine, capture, currentUi)
  if (takeover) return takeover
  // Below the prompt line: that line is the composer, or the echo of the last message, and either can
  // hold anything a person typed.
  if (PERMISSION_UI.test(currentUi.slice(currentUi.indexOf('\n') + 1))) return 'permission'
  return DIALOG_UI.test(currentUi.replace(/Starting MCP servers?/gi, '')) ? 'menu' : null
}

/**
 * The screens of Claude Code 2.1.289 and Codex 0.160 that take the composer's place, where a pasted
 * message and its Enter do something other than send it (read from their code, not run; the screens
 * are in __fixtures__/rewindPickers.ts and takeoverScreens.ts):
 *   - rewind: a picker for a point in the conversation to go back to, whose Enter picks one;
 *   - transcript: Claude Code's transcript view (ctrl+o) and Codex's transcript overlay (ctrl+t, in its
 *     scrollback mode), which drop the paste and have no Enter: the message is lost;
 *   - search: a search through the prompt history (ctrl+r), or Codex's find in its transcript (F3),
 *     which takes the paste as what to search for; Claude Code's Enter then SENDS the earlier prompt it
 *     found, Codex's puts it in the composer or goes to the next match;
 *   - trust, update, model, sign_in: the questions Codex asks at startup (trust this folder, update
 *     now, switch to a new model, how to sign in) and Claude Code's trust and sign-in screens, which
 *     drop the paste and take the Enter as the highlighted answer: trust the folder (Claude Code's
 *     highlights `No, exit`, so it quits), run the update, switch the model, start a sign-in.
 * Each is matched on its own wording and rows, not on a guess at what is missing from the screen.
 */
function takeoverIn(engine: RegisteredSession['engine'], capture: string, currentUi: string): PaneTakeover | null {
  if (engine !== 'claude' && engine !== 'codex') return null
  const lines = stripAnsi(capture).replace(/\u00a0/g, ' ').split('\n')
  const bottom = lines.filter((line) => line.trim()).slice(-3)
  // A startup screen is the last thing on the pane: one with a composer below it was answered.
  const composer = engine === 'codex'
    ? lines.findLastIndex((line) => /^\s*›/.test(line) && !/^\s*›\s*\d+\.\s/.test(line))
    : lines.findLastIndex((line, index) => /^\s*❯/.test(line) && index > 0 && /^\s*[─━]{8,}\s*$/.test(lines[index - 1]))
  const shown = (...patterns: RegExp[]) => patterns.every((pattern) => lines.findLastIndex((line) => pattern.test(line)) > composer)
  if (engine === 'codex') {
    if (CODEX_TRANSCRIPT_BROWSING.test(currentUi)) return 'rewind'
    if (CODEX_PAGER_HEADER.test(lines.find((line) => line.trim()) ?? '')) return 'transcript'
    if (bottom.some((line) => CODEX_SEARCH_FOOTER.test(line))) return 'search'
    if (shown(CODEX_TRUST_QUESTION, CODEX_TRUST_ROW)) return 'trust'
    if (shown(/^\s*Update available\b/, CODEX_UPDATE_ROW)) return 'update'
    if (shown(/^\s*[›>]?\s*1\. Try new model\s*$/, /^\s*[›>]?\s*2\. Use existing model\s*$/)) return 'model'
    if (shown(/^\s*[›>]?\s*1\. Sign in with ChatGPT\s*$/)) return 'sign_in'
    return null
  }
  if (claudeRewindMenuOpen(capture)) return 'rewind'
  if (bottom.some((line) => CLAUDE_TRANSCRIPT_FOOTER.test(line))) return 'transcript'
  if (bottom.some((line) => CLAUDE_HISTORY_SEARCH.test(line))) return 'search'
  if (shown(/Quick safety check: Is this a project you created or one you trust\?/, /^\s*(?:❯\s*)?Yes, I trust this folder\s*$/)) return 'trust'
  if (shown(/^\s*Select login method:\s*$/, /^\s*(?:❯\s*)?1\. Claude account with subscription\b/)) return 'sign_in'
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

/**
 * Claude Code's transcript view (ctrl+o): the prompt is hidden, and the footer row starts
 * `Showing detailed transcript · ctrl+o to toggle`, after `dialog waiting · ` when a dialog sits behind
 * it (2.1.289). It has no Enter, so a message typed there is lost. Esc, q or ctrl+c close it.
 */
const CLAUDE_TRANSCRIPT_FOOTER = /^\s*(?:dialog waiting · )?Showing detailed transcript\b/

/** Claude Code's prompt-history search (ctrl+r), under the prompt: `search prompts: <query>`, or
 *  `no matching prompt: <query>` (2.1.289). */
const CLAUDE_HISTORY_SEARCH = /^\s*(?:search prompts|no matching prompt): /

/**
 * A modal drawn over the pane — a picker, a permission prompt, an MCP boot notice.
 *
 * One copy, shared by every reader here: an engine whose composer needs its own function still meets
 * the same dialogs, and two lists of these would drift the first time either gained an entry.
 * No `g` flag, so `test` carries no `lastIndex` between callers.
 */
const DIALOG_UI = /Select Model(?: and Effort)?|Select Reasoning Level|Advanced Reasoning|Available models|Models matching|Edit Parameters|Type to filter.*Tab to edit|Esc to go back|Press enter to confirm|Do you want to proceed|Allow this action|permission required|Starting MCP servers?/i

/** The approval prompts among them. */
/**
 * An approval prompt's question. Claude Code asks "Do you want to proceed?", "Do you want to make this
 * edit to <file>?", "Do you want to allow Claude to fetch this content?", "Do you want to <verb> <target>?"
 * for the other tools, and "Would you like to proceed?" over a plan (2.1.289); Codex asks "Would you like
 * to run the following command?" and the like. The rows under it are read too (askQuestion.ts), but a
 * row wrapped in a narrow pane breaks that reading, and the question alone must still hold a message:
 * Enter approves the first row. Asked only below the prompt line, so never of what a person typed.
 */
const PERMISSION_UI = /\bDo you want to\b|\bWould you like to (?:proceed|run|make|apply|allow)\b|Allow this action|permission required/i

/**
 * Codex browsing its own transcript: Esc twice on an empty composer, and its footer row reads
 * `Browsing transcript · ↑↓/jk scroll · ←→/hl prompts · … · ↵ rewind · esc back`, down to a bare
 * `Browsing` as the pane narrows (0.160, tui/src/app_backtrack/prompt_navigation.rs). In its default
 * fullscreen mode the composer stays, dimmed whole, placeholder and any draft in it alike, so it read
 * as empty and idle; in its scrollback mode (`tui.fullscreen_transcript = false`, no alternate screen,
 * or over SSH) the footer closes a transcript pager drawn over the whole pane. Either way Enter
 * reverts the conversation to the prompt in view. A paste leaves the fullscreen browser and lands in
 * the composer, but the scrollback one drops it, and its Enter then rewinds (app.rs and
 * pager_overlay/transcript.rs).
 */
const CODEX_TRANSCRIPT_BROWSING = /^\s*Browsing(?: transcript)?(?:\s+·|\s*$)/m

/**
 * Claude Code's Rewind menu (Esc twice on an empty prompt, or `/rewind`), which hides the prompt while
 * it is open. Under its title, `Rewind`, it lists the messages sent so far, `(current)` focused, behind
 * one of these lines, or asks to confirm one picked (2.1.289, MessageSelector). Enter on a message asks
 * to confirm it, and Enter again restores the conversation, the code or both to before it (with file
 * checkpoints off, the first Enter restores the conversation); Enter on `(current)` closes the menu.
 * A message pasted into it is dropped either way. Its focused row is drawn `❯ (current)` in italics,
 * which read as an empty, idle prompt.
 */
// Their opening words only: a pane narrower than a line wraps the rest onto the next, and the menu went
// unseen, its Enter picking a message (with checkpoints off, rewinding to it).
const CLAUDE_REWIND_BODY = /^(?:Restore the code\b|Restore and fork\b|Confirm you want to restore\b|Nothing to rewind to\b)/

function claudeRewindMenuOpen(capture: string): boolean {
  const lines = stripAnsi(capture).replace(/\u00a0/g, ' ').split('\n').map((line) => line.trim())
  // The title, with its body a blank line under it, and no rule after it: the prompt the menu hides
  // comes back between two rules once it closes.
  return lines.some((line, index) => line === 'Rewind'
    && lines.slice(index + 1, index + 4).some((next) => CLAUDE_REWIND_BODY.test(next))
    && !lines.slice(index + 1).some((next) => /[─━]{8,}/u.test(next)))
}

/** The rule a gutter-box composer is closed with: `╹▀▀▀▀…`. */
const GUTTER_BOX_RULE = /[─▀▁▔]{8,}/u

/**
 * A composer drawn as a BOX with a `┃` gutter — OpenCode's and Copilot's, which are the same shape.
 *
 * The generic reader cannot read either one. OpenCode's `┃` does not stop at the text: the last
 * gutter line is the box's own STATUS strip — `Build · <model> · <account>`, sitting directly on
 * the rule that closes the box — so taking the last line carrying the marker reads what the BOX says
 * about itself as something the user typed. Copilot fails one step earlier: its composer carries no
 * `›`/`❯` at all, while every message the user has ALREADY SENT is echoed into the transcript as
 * `❯ <text>` in full brightness, so the generic reader walks back to the last of those and reads a
 * sent message as a draft. Either way the pane was permanently "holding a draft": never idle, and
 * every retarget and model switch refused as AGENT_BUSY over an empty composer. Third variant of the
 * failure hermes had — there the placeholder was not recognised, here the wrong line is read.
 *
 * [hasStatusStrip] is the one thing that differs between the two, and it is OpenCode's alone. The
 * strip is identified by WHERE it is — the gutter line the closing rule sits under — rather than by
 * what it says, which is three variable fields that change with the model, the mode and the account.
 * When no rule follows, no strip is assumed and every gutter line counts as composer: a layout we do
 * not recognise must not silently swallow a line the user typed in. Copilot's box has no strip, so
 * its single gutter line IS the composer and dropping it would read a real draft as an empty prompt
 * — the one direction this must never be wrong in.
 *
 * Every gutter line is checked, not just the last: a long message wraps down the box, and reading
 * one line of it would call a full composer empty.
 *
 * A dialog needs no special case in either engine: both REPLACE the composer with the picker or the
 * permission prompt, so no gutter is on screen at all and the pane reads not-idle from the empty run
 * below rather than from [DIALOG_UI].
 */
function inspectGutterBoxPane(capture: string, hasStatusStrip: boolean): PaneInspection {
  const rawLines = capture.split('\n')
  const marks = /┃/u
  // The LAST contiguous run of gutter lines. Earlier runs are previous composers still in scrollback
  // — the message the user already sent is not a draft.
  const gutter: number[] = []
  for (let index = rawLines.length - 1; index >= 0; index -= 1) {
    if (marks.test(stripAnsi(rawLines[index]))) { gutter.unshift(index); continue }
    if (gutter.length > 0) break
  }
  if (gutter.length === 0) return { idle: false, plan: false, dialog: false, draft: false }
  const last = gutter[gutter.length - 1]
  const closed = last + 1 < rawLines.length && GUTTER_BOX_RULE.test(stripAnsi(rawLines[last + 1]))
  const composer = hasStatusStrip && closed ? gutter.slice(0, -1) : gutter
  const currentUi = stripAnsi(rawLines.slice(gutter[0]).join('\n')).replace(/\u00a0/g, ' ')
  const dialog = DIALOG_UI.test(currentUi)
  const draft = composer.some((index) => {
    const line = rawLines[index]
    const visibleMarker = stripAnsi(line).search(marks)
    if (visibleMarker < 0) return false
    const rawMarker = line.search(marks)
    // The box's interior, not the rest of the row: a panel floating over the composer writes into
    // these same lines, and its text is not a draft. See [gutterBoxInterior]. With no marker in the
    // RAW line there is no interior to bound — read the whole row, the direction that keeps a draft.
    const interior = rawMarker < 0
      ? stripAnsi(line).slice(visibleMarker + 1)
      : gutterBoxInterior(line, rawMarker)
    if (hasPlaceholderSgr(interior) || allVisibleTextIsMuted(interior)) return false
    return stripAnsi(interior).replace(/\u00a0/g, ' ').trim().length > 0
  })
  return { idle: !dialog && !draft, plan: /\bplan mode on\b/i.test(currentUi), dialog, draft }
}

/**
 * The context readout Pi's footer always carries — `0.0%/500k`, `1.5%/200k`. Present whether or not the
 * model advertises a thinking ladder, and drawn by the normal view alone, which is what makes it the
 * honest "the footer is on screen" signal. No `g` flag, so `test` carries no `lastIndex` between calls.
 */
const PI_FOOTER_BUDGET = /\d+(?:\.\d+)?%\s*\/\s*\S+/

/**
 * Grok draws its composer as a ROUNDED BOX, and the generic reader counts the box's own right edge
 * as something the user typed.
 *
 * Its empty composer is one line — `│ ❯` … padding … `│` — inside `╭─…─╮` above and
 * `╰─… Grok 4.6 (xhigh) ─╯` below. The shared reader takes everything after `❯`, strips ANSI, trims,
 * and finds `│`: one character, non-empty, so `draft` was true. Measured on a real pane
 * (`harness-grok-*`, 2026-09-09) with nothing typed into it: `visible after marker = "│"`, `draft =
 * true`, `idle = false`. Not a transient — the edge is drawn on every frame, so idle was false for
 * the agent's whole life and EVERY model switch came back AGENT_BUSY over an empty prompt. Same
 * family as the hermes and gutter-box bugs above; here the culprit is the box, not the placeholder.
 *
 * So the composer is the box's INTERIOR: the run of `│` body lines, read between their first and
 * last `│` rather than from the marker to end-of-line. Every body line is checked, not just the one
 * carrying `❯` — a long message wraps down the box and reading one line of it would call a full
 * composer empty.
 *
 * ⚠️ `│` is also Grok's footer separator (`Shift+Tab:mode │ Ctrl+x:shortcuts`), which sits BELOW the
 * box. It is excluded by requiring a body line to both open and close with `│`, which the footer —
 * one separator, no edges — never does.
 */
function inspectGrokPane(capture: string): PaneInspection {
  const rawLines = capture.split('\n')
  const visibleLines = rawLines.map((line) => stripAnsi(line).replace(/ /g, ' '))
  // The LAST box in the capture. Earlier ones are composers already sent, still in scrollback.
  const bottom = visibleLines.findLastIndex((line) => /^\s*╰[─╌]*.*╯\s*$/u.test(line))
  const top = bottom < 0
    ? -1
    : visibleLines.slice(0, bottom).findLastIndex((line) => /^\s*╭[─╌]+╮\s*$/u.test(line))
  // No recognisable box is "we cannot tell", which the caller reads as busy — the safe direction.
  // Respawning a pane whose layout we do not understand could discard a draft.
  if (top < 0 || bottom - top < 2) return { idle: false, plan: false, dialog: false, draft: false }
  const currentUi = visibleLines.slice(top).join('\n')
  const dialog = DIALOG_UI.test(currentUi)
  const draft = rawLines.slice(top + 1, bottom).some((line, offset) => {
    const visible = visibleLines[top + 1 + offset]
    const first = visible.indexOf('│')
    const last = visible.lastIndexOf('│')
    // Both edges, and not the same character: anything else is not a body line of this box.
    if (first < 0 || last <= first) return false
    const rawMarker = line.search(/[›❯]/u)
    if (rawMarker >= 0 && hasPlaceholderSgr(line.slice(rawMarker + 1))) return false
    // The marker is chrome, not content — it is printed whether or not anything was typed.
    return visible.slice(first + 1, last).replace(/[›❯]/u, '').trim().length > 0
  })
  return { idle: !dialog && !draft, plan: /\bplan mode on\b/i.test(currentUi), dialog, draft }
}

/**
 * Pi draws no composer marker, so idleness is read from its layout instead: the composer is the band
 * between the last two `───` rules, and the footer (`minimax/minimax-m3 • high`) is only rendered by the
 * normal view. A non-empty band is a draft the user is still typing — injecting there would splice a
 * slash command into their sentence.
 */
function inspectPiPane(capture: string): PaneInspection {
  const lines = stripAnsi(capture).split('\n').map((line) => line.replace(/\s+$/, ''))
  const text = lines.join('\n')
  // Whether the footer is DRAWN, which is not the same question as whether its profile can be READ —
  // and conflating the two is what has broken this check twice.
  //
  // `parsePiFooterProfile` is strict on purpose: it must return a model AND an effort or nothing, so a
  // half-drawn redraw is never mistaken for a profile change. Idleness needs far less — only that the
  // normal view is on screen rather than a picker — and borrowing the strict reader for it meant every
  // footer shape it could not fully parse read as "still busy".
  //
  // The shape it could not parse: a model with no thinking ladder draws no `• <level>` at all, so the
  // line ends at the model name. EVERY grid model is that shape, because the provider block written in
  // `gridLaunch.ts` declares `reasoning: false` — which left every Pi agent on a grid permanently
  // AGENT_BUSY, refusing model switches over an idle pane (measured, pi 0.82, footer
  // `↑5.4k ↓292 1.5%/200k (auto)   Auto`).
  //
  // So: the profile still counts when it parses, and the token-budget readout — `0.0%/500k`,
  // `1.5%/200k`, present in both shapes and drawn by no picker — carries the rest.
  const footer = parsePiFooterProfile(text) !== null || PI_FOOTER_BUDGET.test(text)
  const rules: number[] = []
  lines.forEach((line, index) => { if (/^\s*─{8,}\s*$/.test(line)) rules.push(index) })
  const dialog = /Thinking Level|Select reasoning depth|Type to search|Enter to select|Only showing models from/i
    .test(lines.join('\n'))
  if (rules.length < 2) return { idle: false, plan: false, dialog, draft: false }
  const band = lines.slice(rules[rules.length - 2] + 1, rules[rules.length - 1]).join('').trim()
  const draft = band.length > 0
  return { idle: footer && !dialog && !draft, plan: false, dialog, draft }
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

/** The lists a model is chosen from, as against the reasoning screens that follow them. */
function isCodexList(picker: CodexPicker): boolean {
  return picker.kind === 'quick' || picker.kind === 'models' || picker.kind === 'reserve'
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
    const session: RegisteredSession = registeredSession.cliVersion || !observed.cliVersion
      ? registeredSession
      : { ...registeredSession, cliVersion: observed.cliVersion }
    const target = parseRuntimeProfile(encoded)
    // Either id identifies the agent: the encoded profile now carries the agent id, but one minted
    // before the id cutover (or by a client that still knows the session) must keep working.
    if (!target || (target.sessionId !== session.agentId && target.sessionId !== session.sessionId) || target.engine !== session.engine) {
      throw new RuntimeProfileControlError('INVALID_RUNTIME_PROFILE')
    }
    const current = parseRuntimeProfile(this.deps.manager.selectedModel(session))
    if (current?.id === target.id) return
    if (!supportsNativeRuntimeControl(session)) {
      console.warn(`[runtime-profile] unsupported ${session.engine} CLI version ${session.cliVersion ?? 'unknown'} for ${sessionId.slice(0, 8)}`)
      throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')
    }
    // Codex's own catalog: which efforts each model takes, and the names its picker shows them by.
    const codexCatalog = session.engine === 'codex' ? await this.deps.manager.codexCatalog(session) : []
    if (session.engine === 'codex') {
      const listed = codexCatalog.find((entry) => entry.slug === target.model)?.efforts ?? null
      if (!codexEffortAllowed(target.model, target.effort, listed)) throw new RuntimeProfileControlError('EFFORT_UNSUPPORTED')
    }
    const options = await this.deps.manager.modelsForSession(session)
    if (!options.some((option) => option.id === target.id)) {
      const sameModel = options.some((option) => parseRuntimeProfile(option.id)?.model === target.model)
      throw new RuntimeProfileControlError(sameModel ? 'EFFORT_UNSUPPORTED' : 'MODEL_UNAVAILABLE')
    }
    if (session.engine === 'codex' && observed.mode === 'plan') throw new RuntimeProfileControlError('PLAN_SCOPE_AMBIGUOUS')
    const release = this.deps.acquireInput(session.agentId)
    if (!release) throw new RuntimeProfileControlError('BUSY')
    let controlStarted = false
    let pickerOpen = false
    try {
      if (!await this.deps.validateRuntime(session)) throw new RuntimeProfileControlError('TMUX_FAILED')
      const capture = await this.deps.capture(session.agentId, 100)
      if (!capture) throw new RuntimeProfileControlError('TMUX_FAILED')
      const inspection = inspectRuntimePane(session.engine, capture)
      if (session.engine === 'codex' && inspection.plan) throw new RuntimeProfileControlError('PLAN_SCOPE_AMBIGUOUS')
      if (!inspection.idle) throw new RuntimeProfileControlError('BUSY')
      if (!this.deps.manager.beginControl(session, target)) throw new RuntimeProfileControlError('BUSY')
      controlStarted = true
      if (session.engine === 'claude') {
        await this.setClaude(session, target, current, options)
      } else if (session.engine === 'codex') {
        pickerOpen = true
        await this.setCodex(session, target, codexCatalog)
        pickerOpen = false
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
          if (!next || !inspectRuntimePane(session.engine, next).dialog) break
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

  private async setClaude(
    session: RegisteredSession,
    target: RuntimeProfile,
    current: RuntimeProfile | null,
    options: Array<{ id: string }>,
  ): Promise<void> {
    if (current?.model !== target.model) {
      if (!await this.deps.sendText(session.agentId, `/model ${target.model}`)) {
        throw new RuntimeProfileControlError('TMUX_FAILED')
      }
      if (!await this.waitClaudeModel(session)) throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
    }

    if (current?.effort === target.effort) {
      this.deps.manager.confirmEffort(session.sessionId, target.effort)
      return
    }

    const hasExplicitEffort = options.some((option) => {
      const profile = parseRuntimeProfile(option.id)
      return profile?.model === target.model && profile.effort !== 'auto'
    })
    if (!hasExplicitEffort && target.effort === 'auto') {
      this.deps.manager.confirmEffort(session.sessionId, 'auto')
      return
    }
    if (!await this.deps.sendText(session.agentId, `/effort ${target.effort}`)) {
      throw new RuntimeProfileControlError('TMUX_FAILED')
    }
    if (!await this.deps.manager.waitForProfile(session.sessionId, COMMAND_CONFIRM_MS)) {
      await this.deps.sendKey(session.agentId, 'Enter')
      if (!await this.deps.manager.waitForProfile(session.sessionId, 2_000)) {
        throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
      }
    }
  }

  private async waitClaudeModel(session: RegisteredSession): Promise<boolean> {
    if (await this.deps.manager.waitForModel(session.sessionId, 1_200)) return true
    const capture = await this.deps.capture(session.agentId, 80)
    if (capture && /switch model|change model|continue.*model|re-read.*history/i.test(stripAnsi(capture))) {
      await this.deps.sendKey(session.agentId, 'Enter')
    } else {
      // Claude and Codex can swallow the first Enter immediately after a terminal literal write.
      await this.deps.sendKey(session.agentId, 'Enter')
    }
    return this.deps.manager.waitForModel(session.sessionId, COMMAND_CONFIRM_MS)
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
    const confirmed = await this.waitPane(session.agentId, (value) => {
      this.deps.manager.ingestPane(session, value, true)
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
    const confirmed = await this.waitPane(session.agentId, (value) => {
      this.deps.manager.ingestPane(session, value, true)
      return parseRuntimeProfile(this.deps.manager.selectedModel(session))?.model === target.model
    }, COMMAND_CONFIRM_MS)
    return !!confirmed
  }

  /**
   * Codex's `/model`: a quick menu of auto presets with an `All models` row (0.145 and later), the full
   * list (`Select Model and Effort`), then the chosen model's reasoning picker, each row pressed by its
   * digit, which selects the row and accepts it. How a row is read and chosen, and why, is in
   * engines/codex/modelPicker.ts. Confirmed, as it always was, by the `thread_settings_applied` record
   * Codex writes once the choice is applied (RuntimeProfileManager `ingestCodex`).
   */
  private async setCodex(session: RegisteredSession, target: RuntimeProfile, catalog: CodexCatalogModel[]): Promise<void> {
    if (!await this.deps.sendText(session.agentId, '/model')) throw new RuntimeProfileControlError('TMUX_FAILED')
    let picker = await this.waitCodexPicker(session, () => true, 900)
    if (!picker) {
      await this.deps.sendKey(session.agentId, 'Enter')
      picker = await this.waitCodexPicker(session, () => true, PICKER_OPEN_MS)
    }
    if (!picker) throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')
    if (!isCodexList(picker)) {
      // Opened on a reasoning screen: back to the list it was opened from, so the model is chosen too.
      if (!await this.deps.sendKey(session.agentId, 'Escape')) throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')
      if (!await this.waitCodexPicker(session, isCodexList, PICKER_STEP_MS)) throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')
    }
    const reached = await this.reachCodexEfforts(session, target, catalog)
    if (reached !== 'applied') await this.pickCodexEffort(session, target, reached)
    if (!await this.deps.manager.waitForProfile(session.sessionId, COMMAND_CONFIRM_MS)) {
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
    session: RegisteredSession,
    target: RuntimeProfile,
    catalog: CodexCatalogModel[],
  ): Promise<CodexPicker | 'applied'> {
    let reread = false
    for (let lists = 0; lists < 2; lists++) {
      const list = await this.settledCodexList(session)
      if (!list) throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
      let choice = chooseCodexRow(list, target, catalog)
      if ('error' in choice && choice.error === 'MODEL_UNAVAILABLE' && !reread) {
        // Codex saves the catalog its picker refreshed from to models_cache.json, so a model or a name
        // that came with the refresh is there to read now.
        reread = true
        catalog = await this.deps.manager.codexCatalog(session)
        choice = chooseCodexRow(list, target, catalog)
      }
      if ('error' in choice) throw new RuntimeProfileControlError(choice.error)
      if (!await this.deps.sendKey(session.agentId, String(choice.row.number))) throw new RuntimeProfileControlError('TMUX_FAILED')
      if (choice.opens === 'list') {
        if (!await this.waitCodexPicker(session, (next) => next.kind === 'models', PICKER_STEP_MS)) {
          throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')
        }
        continue
      }
      if (choice.opens === 'applied') return 'applied'
      const next = await this.waitCodexAfterModelRow(session)
      if (next === 'closed') return 'applied'
      if (!next) throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')
      if (next.model !== choice.row.name) throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
      return next
    }
    throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
  }

  /** The target's effort in its reasoning picker, through Advanced Reasoning for Max and Ultra. */
  private async pickCodexEffort(session: RegisteredSession, target: RuntimeProfile, picker: CodexPicker): Promise<void> {
    const rows = codexEffortRows(picker)
    let row = target.effort === 'auto' ? rows.defaultRow : rows.efforts.get(target.effort) ?? null
    if (row === null && (target.effort === 'max' || target.effort === 'ultra') && rows.advancedRow !== null
      && codexDigitPressable(rows.advancedRow)) {
      if (!await this.deps.sendKey(session.agentId, String(rows.advancedRow))) throw new RuntimeProfileControlError('TMUX_FAILED')
      const advanced = await this.waitCodexPicker(session, (next) => next.kind === 'advanced', PICKER_STEP_MS)
      row = advanced ? codexEffortRows(advanced).efforts.get(target.effort) ?? null : null
    }
    if (row === null || !codexDigitPressable(row)) throw new RuntimeProfileControlError('EFFORT_UNSUPPORTED')
    if (!await this.deps.sendKey(session.agentId, String(row))) throw new RuntimeProfileControlError('TMUX_FAILED')
  }

  /** The first Codex picker on the pane that `wanted` takes, polled until `timeoutMs`. */
  private async waitCodexPicker(
    session: RegisteredSession,
    wanted: (picker: CodexPicker) => boolean,
    timeoutMs: number,
  ): Promise<CodexPicker | null> {
    const capture = await this.waitPane(session.agentId, (value) => {
      const picker = parseCodexPicker(value)
      return !!picker && wanted(picker)
    }, timeoutMs)
    return capture ? parseCodexPicker(capture) : null
  }

  /** A model list that reads the same twice, CODEX_SETTLE_MS apart (see reachCodexEfforts). */
  private async settledCodexList(session: RegisteredSession): Promise<CodexPicker | null> {
    let previous: CodexPicker | null = null
    const deadline = Date.now() + PICKER_STEP_MS
    while (Date.now() < deadline) {
      const capture = await this.deps.capture(session.agentId, 100)
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
  private async waitCodexAfterModelRow(session: RegisteredSession): Promise<CodexPicker | 'closed' | null> {
    const deadline = Date.now() + PICKER_STEP_MS
    while (Date.now() < deadline) {
      const capture = await this.deps.capture(session.agentId, 100)
      if (capture) {
        const picker = parseCodexPicker(capture)
        if (picker?.kind === 'efforts') return picker
        if (!picker && inspectRuntimePane('codex', capture).idle) return 'closed'
      }
      await sleep(100)
    }
    return null
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

    const confirmed = await this.waitPane(session.agentId, (value) => {
      this.deps.manager.ingestPane(session, value, true)
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

  private async waitPane(terminalTarget: string, predicate: (capture: string) => boolean, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const capture = await this.deps.capture(terminalTarget, 100)
      if (capture && predicate(capture)) return capture
      await sleep(100)
    }
    return null
  }
}
