/**
 * Whether Claude Code's or Codex's own composer is on screen, ready for a message: what a message is
 * typed into, and nothing else (messageHold.ts). An allowlist, so a screen never seen before is not
 * typed into: it is refused, where a list of screens to refuse would have let it through.
 *
 * Read from the engines' own code (Claude Code 2.1.289's bundle, Codex 0.160's tui/src), not run:
 *   - Claude Code draws its prompt in a box ruled above and below (`borderStyle: "round"` with no
 *     sides, the rule full width, text in the top rule at times), `❯` and the prompt in it, its further
 *     lines under the first; under the box, its footer, or the suggestions for a `/command` or an
 *     `@mention` being typed, which take the footer's place (`Kge`, padded to six rows or more).
 *     Every dialog, menu and view hides the box.
 *   - Codex draws a blank row, then `›` in bold (`»` at its top reasoning effort; dim while input is
 *     disabled, `!` in shell mode) and the draft or its dim placeholder at the left edge, its further
 *     lines under it, then a blank row and its footer, one or two rows, at the bottom of the pane
 *     (chat_composer.rs, snapshots `empty`, `draft_composer`, `status_and_queued_messages`). Its popups
 *     are drawn above the composer: the `/command` list (snapshot `slash_popup_footer_wide`) and the
 *     mention menu with its `enter/tab insert · esc close` row (`default_unified_mention_popup`). Its
 *     approvals, questions, pickers and startup screens replace it; a picker's rows are numbered.
 * A popup open over the composer is no composer to type into: its Enter picks the highlighted row.
 */
import { stripVTControlCharacters } from 'node:util'
import type { RegisteredSession } from './registry.js'

export type ComposerState = 'ready' | 'popup' | 'absent'

/** The engines read this way. Every other engine is read only for the screens known to refuse. */
export const COMPOSER_ENGINES: ReadonlySet<string> = new Set(['claude', 'codex'])

/** A row of Claude Code's rule: all `─`, or `─` at both ends with text set in it. */
const CLAUDE_RULE = /^─{3,}$|^─{3,}.*─{3,}$/

/** Codex's composer row: `›` (or `»`) at the left edge, never a numbered row of a picker. */
const CODEX_COMPOSER = /^[›»](?:\s|$)/
const CODEX_PICKER_ROW = /^[›»]\s*\d+\.\s/

function screenLines(capture: string): { lines: string[]; raw: string[] } {
  const raw = capture.split('\n')
  const lines = raw.map((line) => stripVTControlCharacters(line).replace(/ /g, ' ').trimEnd())
  while (lines.length && !lines.at(-1)) { lines.pop(); raw.pop() }
  return { lines, raw }
}

/** Whether the first character of a row is drawn bold: the SGR in force when it is written. */
function startsBold(row: string): boolean {
  let bold = false
  const sgr = /^\u001b\[([0-9;:]*)m/
  let rest = row
  for (let match = sgr.exec(rest); match; match = sgr.exec(rest)) {
    for (const code of match[1].split(/[;:]/)) {
      if (code === '1') bold = true
      else if (code === '' || code === '0' || code === '22') bold = false
    }
    rest = rest.slice(match[0].length)
  }
  return bold
}

/** The word being typed at the end of a draft, where a `/command` or an `@mention` opens its popup. */
function typedToken(draft: string): string {
  return draft.split(/\s/).at(-1) ?? ''
}

export function composerState(engine: RegisteredSession['engine'], capture: string): ComposerState {
  const { lines, raw } = screenLines(capture)
  return engine === 'codex' ? codexComposer(lines, raw) : claudeComposer(lines)
}

function claudeComposer(lines: string[]): ComposerState {
  let prompt = lines.findLastIndex((line) => /^❯(?:\s|$)/.test(line))
  let bottom = lines.findIndex((line, index) => index > prompt && CLAUDE_RULE.test(line.trim()))
  if (prompt < 1 || !CLAUDE_RULE.test(lines[prompt - 1].trim()) || bottom < 0) {
    // A draft taller than the pane: Claude Code does not cap the prompt's height outside its fullscreen
    // renderer (2.1.289 passes `maxVisibleLines` only there), so the box's top rule and its `❯` row
    // scroll off, and the pane shows the draft's further rows, indented under the `❯`, down to the
    // bottom rule. Every row above that rule is one of them; a dialog's are indented by one column, the
    // conversation's start at the edge.
    bottom = lines.findIndex((line) => CLAUDE_RULE.test(line.trim()))
    if (bottom < 1 || !lines.slice(0, bottom).every((line) => !line || line.startsWith('  '))) return 'absent'
    prompt = -1
  }
  const below = lines.slice(bottom + 1)
  // Nothing ruled under the box: a dialog of Claude Code's own is drawn ruled, in its place.
  if (below.some((line) => CLAUDE_RULE.test(line.trim()))) return 'absent'
  const draft = [prompt < 0 ? '' : lines[prompt].replace(/^❯\s?/, ''), ...lines.slice(prompt + 1, bottom).map((line) => line.trim())].join(' ').trim()
  const token = typedToken(draft)
  const rows = below.map((line) => line.trim()).filter(Boolean)
  if (token.startsWith('/') && rows.some((row) => /^\/[\w:.-]/.test(row))) return 'popup'
  if (token.startsWith('@')) {
    const typed = token.slice(1).toLowerCase()
    // A file or agent suggestion, by what is typed after the `@`; with nothing typed yet, any row but the
    // footer's own (its mode and its hints).
    if (rows.some((row) => typed ? row.replace(/^@/, '').toLowerCase().startsWith(typed) : !/^(?:\?|⏵|esc\b)/.test(row))) return 'popup'
  }
  return 'ready'
}

function codexComposer(lines: string[], raw: string[]): ComposerState {
  const composer = lines.findLastIndex((line) => CODEX_COMPOSER.test(line) && !CODEX_PICKER_ROW.test(line))
  // Bold, on a row of its own under a blank one: not a line of the conversation, nor a disabled composer.
  if (composer < 0 || !startsBold(raw[composer]) || (composer > 0 && lines[composer - 1].trim())) return 'absent'
  // The draft's further lines, then a blank row and the footer: nothing more is drawn under Codex's
  // composer, so more is some other screen under a line of the conversation.
  let end = composer + 1
  while (end < lines.length && lines[end].trim()) end++
  const footer = lines.slice(end).filter((line) => line.trim())
  if (footer.length > 3) return 'absent'
  const draft = [lines[composer].replace(/^[›»]\s?/, ''), ...lines.slice(composer + 1, end).map((line) => line.trim())].join(' ').trim()
  const token = typedToken(draft)
  // A voice send was refused as popup_open even though the recording had transcribed. Looking through
  // twenty conversation rows also matched command examples and old menu hints. A popup is the block
  // immediately above the composer; a slash menu has a selected row and edits the initial /command.
  let popupEnd = composer - 1
  while (popupEnd >= 0 && !lines[popupEnd].trim()) popupEnd--
  let popupStart = popupEnd
  while (popupStart >= Math.max(0, composer - 20) && lines[popupStart].trim()) popupStart--
  const above = lines.slice(popupStart + 1, popupEnd + 1)
  if (draft.startsWith('/') && token.startsWith('/') && above.some((line) => /^›\s+\/[\w-]+(?:\s{2,}\S|$)/.test(line))) return 'popup'
  if (token.startsWith('@') && above.some((line) => /\benter\/tab insert · esc close\b/.test(line))) return 'popup'
  return 'ready'
}
