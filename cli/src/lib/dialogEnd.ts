/**
 * Where an EARLIER dialog ends on a pane: the one bound every engine's pane reader shares.
 *
 * A pane keeps an answered dialog in its scrollback and paints the next one under it, so the live dialog is
 * always the LAST one on screen. Every reader anchors low (a footer, the bottom-most rows) and walks UP for
 * the rest: the question, the title, the command, a frame's top. Nothing at or above an earlier dialog's
 * end belongs to the live one. Read across it, an unframed prompt was titled by the PREVIOUS prompt's
 * header and command (`Approve Bash command: npm test` over `python3 wipe.py --all`), under that prompt's
 * very requestId.
 *
 * A dialog ends in its key hints on a line of their own, right under its rows. Both halves are needed:
 * prose can mention a key (`Make Esc close the modal`), and a numbered list is not a dialog. Every engine's
 * spelling is known here, not only the reader's own, because what sits above the live dialog is whatever
 * the pane showed last.
 *
 * Separate from `askQuestion.ts` because the engines' readers use it and `askQuestion.ts` imports them.
 */

/** A live dialog's footer, the shared reader's anchor (`parseQuestionPane`). Each CLI words its own, and
 *  OpenCode rewords it per screen (`enter submit`, `enter toggle`, `enter confirm`); Codex's
 *  request_user_input says `enter to submit answer`. Hermes' batch panel says `Enter to lock, Tab next
 *  question…` — one question alone still gets that panel, and its footer was read as "no dialog" until
 *  `lock` was accepted here. */
export const QUESTION_FOOTER_RE = /enter to (select|confirm|submit|lock)|enter\s+(submit|confirm|toggle)/i

/** The key hints a permission dialog prints under its rows: claude `Esc to cancel · Tab to amend`,
 *  Command Code `↑/↓ navigate · enter select · ctrl+e explain`. Proximity to the rows is what makes this
 *  a guard and not a search: it must sit within a few lines UNDER them. */
// Claude's plan review footer changed from Esc/Tab hints to
// "shift+tab to approve with this feedback" plus ctrl+g. Never the spinner of a turn at work, which sits
// right under its output in every engine (`esc to interrupt`): a numbered list in that output read as a
// permission prompt, and a message sent mid-turn was held for one that was not there.
export const PERMISSION_FOOTER_RE = /\besc\b(?! to interrupt)|enter\s+select|ctrl\+e|shift\+tab\s+to\s+approve/i

/** The footers only an engine's own reader anchors on: devin `↵ select` / `↵ confirm`, grok `Enter:submit`
 *  / `1/3:select`, agy and grok `navigate`, muse and amp `↑/↓ to move` / `↑/↓/j/k move`. */
const ENGINE_FOOTER_RE = /↵\s*(select|confirm)|enter\s*:\s*submit|\d+\/\d+\s*:\s*select|\bnavigate\b|↑\/↓(\/j\/k)?\s+(to\s+)?move\b/i

/** How a key-hint line starts (`Esc to cancel`, `Enter to select`, `↑/↓ navigate`, `Press enter to confirm`,
 *  grok's `up/down navigate` and `1/3:select`), and prose that merely mentions a key does not. */
const HINT_START_RE = /^\s*(esc\b|enter\b|tab\b|shift\+tab\b|ctrl\+|press enter\b|up\/down\b|\d+\/\d+\s*:\s*select\b|[↑↓⇆←→])/i

/** Kilo's and OpenCode's approval, whose options share their line with the key hints:
 *  `Allow once   Allow always   Reject      ctrl+f fullscreen  ⇆ select  enter confirm`. */
const OPTIONS_AND_HINTS_RE = /^\s*[A-Z][^\s│┃|]*(?: \S+)*\s{2,}.*\benter\s+confirm\b/

/** A row, in every engine's spelling: `❯ 1. Yes`, devin's `❭ 1 Xanh` / `□ 2 Đỏ`, grok's `2 (○) Yes, proceed`. */
const ROW_RES = [
  /^\s*[❯›>]?\s*\d+\.\s+\S/,
  /^\s*[❭❯›>·□■☑✔]\s+\d+\s+\S/,
  /^\s*[❯›>]?\s*[0-9a-z]\s+\([^)]*\)\s+\S/i,
]

/** A line without the frame drawn around it: hermes and copilot `│ … │`, opencode and kilo `┃`, grok `|`. */
function unrail(line: string): string {
  return line.replace(/^\s*[│┃|]\s?/, '').replace(/\s*[│┃|]\s*$/, '')
}

/** Is line `i` the end of a dialog: its key hints, with its rows right above? */
export function isDialogEnd(lines: string[], i: number): boolean {
  const line = unrail(lines[i] ?? '')
  if (OPTIONS_AND_HINTS_RE.test(line)) return true
  if (!HINT_START_RE.test(line)) return false
  if (!PERMISSION_FOOTER_RE.test(line) && !QUESTION_FOOTER_RE.test(line) && !ENGINE_FOOTER_RE.test(line)) return false
  // Its rows sit just above, give or take a rule, a status line or a box's closing border (hermes paints
  // two lines of security scan between its last row and its frame).
  for (let j = i - 1; j >= 0 && i - j <= 8; j--) {
    const above = unrail(lines[j])
    if (ROW_RES.some((re) => re.test(above))) return true
  }
  return false
}

/**
 * Where an earlier dialog ends above line `start` (within `reach` lines), or -1. A reader walking up from
 * `start` stops strictly below it.
 */
export function earlierDialogEnd(lines: string[], start: number, reach: number): number {
  for (let i = Math.min(start, lines.length) - 1; i >= 0 && start - i <= reach; i--) {
    if (isDialogEnd(lines, i)) return i
  }
  return -1
}
