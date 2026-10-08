import type { ComposerState } from '../facets/screen.js'
import { screenLines, startsBold, typedToken } from '../kit/composer.js'

/** Codex's composer row: `›` (or `»`) at the left edge, never a numbered row of a picker. */
const CODEX_COMPOSER = /^[›»](?:\s|$)/
const CODEX_PICKER_ROW = /^[›»]\s*\d+\.\s/

export function composerState(capture: string): ComposerState {
  const { lines, raw } = screenLines(capture)
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
