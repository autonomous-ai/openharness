/**
 * agy's ask-the-user dialog, read off a real pane.
 *
 * Measured on agy 1.1.14 (`__fixtures__/question-agy.txt`):
 *
 *     ? Which colour do you prefer?
 *     Question
 *     ────────────────────────────────────────────
 *     Question 1/1: Which colour do you prefer?
 *     > 1. Red
 *       2. Green
 *       3. Blue
 *       4. Write-in...
 *       ↑/↓ Navigate · enter Select · esc Skip
 *
 * The shared parser returns null here: its anchors are footers like `Press enter to confirm`, and
 * agy's says `↑/↓ Navigate · enter Select · esc Skip`. The `Question N/M:` line is the reliable one —
 * it is the only place the question text appears in a form that is neither a `?` echo nor the box
 * heading, and it also says how many questions are queued behind this one.
 *
 * agy's PERMISSION prompt is a different dialog and the SHARED parser reads it correctly already
 * (numbered rows under `Do you want to proceed?`), so it deliberately falls through.
 *
 * Selection is by digit: typing `3` on a live pane picked Blue immediately, with no Enter.
 */

import type { FoundDialog, PaneView, QuestionRow } from '../../lib/askQuestion.js'
import { earlierDialogEnd } from '../../lib/dialogEnd.js'

const ESCAPES = /\u001b\[[0-9;:]*[A-Za-z]/g
/** `Question 1/1: <text>` — the `N/M` counter is what tells this dialog apart from an echoed prompt. */
const HEADING = /^Question\s+\d+\/\d+:\s*(.+?)\s*$/
/** `> 1. Red` / `  2. Green`; the caret marks the highlighted row and is not part of the label. */
const ROW = /^\s*[>›]?\s*(\d+)\.\s+(.*?)\s*$/
const FOOTER = /↑\/↓\s*Navigate/

/**
 * Rows that open a free-text editor.
 *
 * Dropped rather than offered: the device has no text input, so a "Write-in..." row is a dead end
 * there — the same call muse's "None of the above" forced.
 */
const WRITE_IN = /^write[- ]?in\b/i

export function parseAgyQuestionPane(capture: string): PaneView {
  return locateAgyQuestion(capture)?.view ?? null
}

/** `parseAgyQuestionPane`, with the footer it anchored on. */
export function locateAgyQuestion(capture: string): FoundDialog | null {
  const lines = capture.replace(ESCAPES, '').split('\n').map((line) => line.trimEnd())
  const footer = lines.findLastIndex((line) => FOOTER.test(line))
  if (footer === -1) return null

  // Up to the heading, and never past an earlier dialog's end: its heading is not this one's.
  const floor = earlierDialogEnd(lines, footer, footer)
  const rows: QuestionRow[] = []
  let question = ''
  for (let i = footer - 1; i > floor; i--) {
    const line = lines[i]
    if (!line.trim()) continue
    const heading = HEADING.exec(line.trim())
    if (heading) { question = heading[1]; break }
    const row = ROW.exec(line)
    if (!row) {
      // A non-row, non-heading line between the rows and the heading means this is not the dialog.
      if (rows.length) return null
      continue
    }
    if (WRITE_IN.test(row[2])) continue
    rows.unshift({ number: row[1], label: row[2], checked: false })
  }
  if (!question || rows.length < 2) return null
  return { view: { kind: 'question', question, rows, multi: false, typeRow: null }, at: footer }
}
