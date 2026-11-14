import type { ComposerState } from '../facets/screen.js'
import { rowBackgrounds, screenLines, startsBold, typedToken } from '../kit/composer.js'

/** Codex's composer row: `›` (or `»`) at the left edge, never a numbered row of a picker. */
const CODEX_COMPOSER = /^[›»](?:\s|$)/
const CODEX_PICKER_ROW = /^[›»]\s*\d+\.\s/
/** A further row of a draft: Codex draws each two columns in, under the text after its `›`. */
const DRAFT_ROW = /^ {2}/
/** What a dialog or picker draws and a draft does not: a numbered choice, or the key that answers it. */
const ANSWERED = /^\s*(?:[›»]\s*)?\d+\.\s|\b(?:enter|esc)\b.*\b(?:confirm|continue|cancel|close|select)\b/i

/**
 * Where an unshaded draft in paragraphs ends: at the blank row above the footer, when every row from the composer down to it
 * is a draft's (blank, or two columns in), the footer is at most three such rows, and nothing there answers a dialog; else
 * null. A draft holding a numbered list, or the words of a dialog's keys, is read as covered and held, as before: a wrong
 * "ready" would press Enter into a dialog. A message in paragraphs (who it is from, the text, the line to answer with), in a
 * Codex in a pane no window shows, has no background to shade its composer from: ended at its first blank row, the rest read as a screen under it, and
 * its Enter was never pressed.
 */
function paragraphsEnd(lines: readonly string[], composer: number): number | null {
  const last = lines.findLastIndex((line) => !line.trim())
  const footer = lines.slice(last + 1)
  const drawn = (line: string) => DRAFT_ROW.test(line) && !ANSWERED.test(line)
  return footer.length <= 3 && footer.every(drawn) && lines.slice(composer + 1, last).every((line) => !line.trim() || drawn(line)) ? last : null
}

export function composerState(capture: string): ComposerState {
  const { lines, raw } = screenLines(capture)
  const composer = lines.findLastIndex((line) => CODEX_COMPOSER.test(line) && !CODEX_PICKER_ROW.test(line))
  // Bold, on a row of its own under a blank one: not a line of the conversation, nor a disabled composer.
  if (composer < 0 || !startsBold(raw[composer]) || (composer > 0 && lines[composer - 1].trim())) return 'absent'
  // The draft's further lines, then a blank row and the footer: nothing more is drawn under Codex's
  // composer, so more is some other screen under a line of the conversation. Codex shades its composer
  // (0.162 on a dark pane): the shaded rows are the draft, blank ones included. Ending a draft at its first
  // blank row instead read a message in paragraphs, typed into an idle Codex, as a prompt something had
  // covered, and its Enter was held back (a fresh Mac, 2026-10-12). Unshaded, a draft ends at a blank row, or runs on
  // over its paragraphs to the footer (paragraphsEnd).
  const shades = rowBackgrounds(raw)
  const shade = shades[composer]
  let end = composer + 1
  if (shade) while (end < lines.length && shades[end] === shade) end++
  else while (end < lines.length && lines[end].trim()) end++
  if (lines.slice(end).filter((line) => line.trim()).length > 3) {
    const paragraphs = shade ? null : paragraphsEnd(lines, composer)
    if (paragraphs === null) return 'absent'
    end = paragraphs
  }
  const draft = [lines[composer].replace(/^[›»]\s?/, ''), ...lines.slice(composer + 1, end).map((line) => line.trim()).filter(Boolean)].join(' ').trim()
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
