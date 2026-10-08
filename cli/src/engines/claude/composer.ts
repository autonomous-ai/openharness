import type { ComposerState } from '../facets/screen.js'
import { screenLines, typedToken } from '../kit/composer.js'

/** A row of Claude Code's rule: all `─`, or `─` at both ends with text set in it. */
const CLAUDE_RULE = /^─{3,}$|^─{3,}.*─{3,}$/

export function composerState(capture: string): ComposerState {
  const { lines } = screenLines(capture)
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

