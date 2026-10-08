import type { FoundDialog, PaneView, QuestionRow, QuestionView } from '../facets/screen.js'
import { earlierDialogEnd, PERMISSION_FOOTER_RE, QUESTION_FOOTER_RE } from '../../lib/dialogEnd.js'

// Rows that exist in every dialog but can never BE an answer.
const CHAT_ROW = /^chat about (this|these)$/i
// Claude writes "Type something.", Command Code "Type something..." — one trailing dot or three, and
// missing it costs the free-text row: a voice answer would have nowhere to go and the row would be
// offered on the device as if it were a real option.
// Claude "Type something.", Command Code "Type something...", OpenCode "Type your own answer", Hermes
// "Other (type your answer)". Same row in every dialog: it opens an editor instead of choosing, so it must
// never be offered to the device as a selectable label.
const TYPE_ROW = /^(type something\.{0,3}|type your own( answer)?|other \(type your (own|answer)\))$/i

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;:]*[A-Za-z]/g, '')
}

function norm(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/[.…]+$/, '').trim()
}

export function parseRow(line: string): QuestionRow | null {
  // Consume indentation once: two adjacent whitespace runs backtrack across
  // every possible split on the padded non-option lines in terminal captures.
  const m = /^[❯›>]?\s*(\d+)\.\s+(.+?)\s*$/.exec(line.trimStart())
  if (!m) return null
  const raw = m[2]
  const box = /^\[([^\]])\]\s*(.*)$/.exec(raw)
  return {
    number: m[1],
    label: (box ? box[2] : raw).trim(),
    checked: !!box && box[1].trim() !== '',
  }
}

/**
 * Read the CURRENT dialog off a pane capture. The capture includes scrollback (old dialogs, old plan
 * text), so everything is anchored to the LAST footer line — the only marker the live dialog always
 * paints at the bottom of the screen.
 */
/** "❯ 1. Submit" immediately followed by "2. Cancel" — Command Code's review screen, which carries no
 *  other marker. Returns the Submit row's number and where it sits, or null. */
function findSubmitPair(lines: string[]): { row: string; index: number } | null {
  for (let i = lines.length - 1; i >= 1; i--) {
    const row = parseRow(lines[i])
    if (!row || !/^submit$/i.test(row.label)) continue
    const next = parseRow(lines[i + 1] ?? '')
    if (next && /^cancel$/i.test(next.label)) return { row: row.number, index: i }
  }
  return null
}

/** The tab bar of a footer-less dialog: "● Loại game | ◯ Review". Returns its LAST occurrence, or -1. */
function findTabBarDialog(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!/^[●◯✔✓]/.test(line) || !line.includes('|')) continue   // answered tabs turn into ✔
    // Only a tab bar with a numbered list under it is a question; the same glyphs appear in prose.
    for (let j = i + 1; j < lines.length && j - i <= 8; j++) {
      const row = parseRow(lines[j])
      if (row?.number === '1') return i
    }
  }
  return -1
}

/** Read a dialog that has no footer: question first, then the numbered rows, top-down from the tab bar. */
function parseDownward(lines: string[], tabBar: number): PaneView {
  let question = ''
  const rows: QuestionRow[] = []
  let checkbox = false
  for (let i = tabBar + 1; i < lines.length; i++) {
    const row = parseRow(lines[i])
    if (row) {
      if (/^\s*[❯›>]?\s*\d+\.\s+\[/.test(lines[i])) checkbox = true
      rows.push(row)
      continue
    }
    // Between the tab bar and row 1 sits the question; after the rows start, plain lines are the option
    // descriptions and must not overwrite it.
    const line = lines[i].trim()
    if (!question && rows.length === 0 && line && !/^[─━-]{6,}$/.test(line)) question = line
  }
  if (!rows.length) return null
  const answerable = rows.filter((r) => !CHAT_ROW.test(r.label) && !TYPE_ROW.test(r.label))
  return {
    kind: 'question',
    question,
    rows: answerable,
    multi: checkbox,
    typeRow: rows.find((r) => TYPE_ROW.test(r.label)) ?? null,
  }
}

// \u2500\u2500 permission prompts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * A permission prompt is a QUESTION whose options are the approval choices \u2014 the shape amp and kilo
 * already ship (`engines/amp/askQuestion.ts`, `engines/kilo/askQuestion.ts`). It matters far more on a
 * remote machine than a question does: the CLI attaches to an agent the USER started, under the user's
 * own config and with no permission flag of ours (`engines/README.md`), so a blocking approval is the
 * normal state of a pane, not an edge case. Unparsed, the turn simply sits at `Processing` until someone
 * walks to the computer.
 *
 * Claude and Command Code draw it as a framed block ending in numbered rows, and it carries NONE of the
 * three anchors `parseQuestionPane` knows. Captured live (`__fixtures__/permission-claude.txt`):
 *
 *   \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
 *    Bash command                                    \u2190 the header: what kind of approval this is
 *
 *      curl -s https://api.coingecko.com/\u2026           \u2190 the argument, then a one-line description
 *      Fetch Bitcoin price from CoinGecko API
 *
 *    This command requires approval
 *
 *    Do you want to proceed?
 *    \u276f 1. Yes
 *      2. Yes, and don\u2019t ask again for: curl *
 *      3. No
 *
 *    Esc to cancel \u00b7 Tab to amend \u00b7 ctrl+e to explain
 *
 * Command Code differs only in wording (`permission-commandcode.txt`): header `Execute Shell Command`,
 * a sentence for the body, footer `\u2191/\u2193 navigate \u00b7 enter select \u00b7 ctrl+e explain`. Same frame, same rows \u2014
 * which is why one parser covers both instead of two near-copies that would drift apart.
 *
 * **The prose is not the anchor.** Every engine words it differently and Claude alone writes at least
 * three ("Do you want to proceed?", "Do you want to make this edit to README.md?", "Do you want to create
 * \u2026?"). The ROWS are: an approval always offers a way to say yes and a way to say no. That pair is the
 * signal, guarded by the dialog's own key hints so an ordinary numbered list in assistant output can never
 * be read as a prompt.
 */

/** The first row of an approval, measured across claude, commandcode, codex, devin, grok, amp and kilo. */
const APPROVE_RE = /^(yes|allow|approve|accept|proceed|run|continue)\b/i
/** \u2026and the row that declines it. Never dropped \u2014 see the rule amp's parser states: a device user given
 *  three ways to say yes and none to say no cannot answer the prompt at all. */
// `skip` is here because cursor's decline row is "Skip & tell the agent what to do instead" — an engine
// whose only way to refuse says neither "no" nor "reject" would otherwise fail the yes/no guard and its
// whole prompt would go unread.
// Claude's plan review does not use a negative verb at all: its only refusal
// row is "Tell Claude what to change". Keep `tell ... what to change` narrow so
// an ordinary numbered list beginning with "Tell" cannot become an approval.
const REJECT_RE = /^(no|reject|deny|decline|cancel|skip|don'?t|stop)\b|^tell\b.*\bwhat to change\b/i
/** The solid rule that opens the frame. Deliberately NOT the dashed one (`\u254c`) that brackets an edit diff,
 *  which sits BELOW the header and would cost the title. */
const FRAME_RULE_RE = /^\s*[\u2500\u2501\u2550]{6,}\s*$/
/** Any rule, solid or dashed \u2014 used to skip them while reading the frame's contents. */
const ANY_RULE_RE = /^\s*[\u2500\u2501\u2550\u254c\u2504\u2508-]{6,}\s*$/
/** The dialog's own question line, and Command Code's `Press [ctrl+e] \u2026` hint: both sit between the
 *  header and the rows, and neither says what is being approved. */
const PERMISSION_PROSE_RE = /^((do|would) you\b|press \[)/i

/** The opening rule of the frame the rows at `start` sit in, or -1 when they have none of their own. */
function frameTop(lines: string[], start: number, floor: number): number {
  for (let i = start - 1; i > floor && start - i <= 25; i--) {
    if (FRAME_RULE_RE.test(lines[i])) return i
  }
  return -1
}

/** Keep a synthesised title inside the device's `text[200]` buffer, with the tail marked as cut. */
function clipTitle(value: string): string {
  return value.length <= 160 ? value : `${value.slice(0, 159)}\u2026`
}

/**
 * What is being approved, as one line: `Approve <header>: <argument>`, the form amp's parser already
 * produces so the two read alike on the device.
 *
 * The frame's opening rule is the only reliable top \u2014 the prose under it varies per engine AND per tool.
 * Below the rule sit the header (`Bash command`, `Edit file`, `Execute Shell Command`) and then the
 * argument: the command, the file, or the sentence naming it.
 */
function permissionTitle(lines: string[], start: number): string {
  // The header must be THIS dialog's: never read past the end of an earlier one still in scrollback.
  const floor = earlierDialogEnd(lines, start, 25)
  const top = frameTop(lines, start, floor)
  // No frame above the rows (codex draws none): the nearest text is the dialog's own question, which
  // names the command outright. Better than inventing a header that is not on screen.
  if (top < 0) {
    for (let i = start - 1; i > floor && start - i <= 4; i--) {
      const line = lines[i].trim()
      if (line) return clipTitle(line)
    }
    return 'Approval required'
  }
  let header = ''
  let arg = ''
  for (let i = top + 1; i < start; i++) {
    const line = lines[i].trim()
    if (!line || ANY_RULE_RE.test(line)) continue
    if (!header) { header = line; continue }
    if (PERMISSION_PROSE_RE.test(line)) continue
    arg = line
    break
  }
  if (!header) return 'Approval required'
  return clipTitle(arg ? `Approve ${header}: ${arg}` : `Approve ${header}`)
}

/**
 * The permission prompt on screen, with the index of its first row so the caller can rank it against the
 * other anchors.
 *
 * Only the LOWEST numbered block on the pane is considered, and it is rejected outright if it is not an
 * approval. Digging further up would find an answered prompt in the scrollback and re-announce it \u2014 the
 * live dialog is always the bottom-most thing on screen, so there is nothing below it to miss.
 */
export function parsePermissionPane(lines: string[]): { view: QuestionView; index: number } | null {
  let end = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (parseRow(lines[i])) { end = i; break }
  }
  if (end < 0) return null

  // Walk up through CONTIGUOUS rows to the one numbered 1. Contiguity is the point: a permission dialog
  // never interleaves prose with its options, while assistant output that happens to be numbered does.
  const rows: QuestionRow[] = []
  let start = -1
  for (let i = end; i >= 0 && end - i < 12; i--) {
    const row = parseRow(lines[i])
    if (!row) break
    rows.unshift(row)
    if (row.number === '1') { start = i; break }
  }
  if (start < 0 || rows.length < 2) return null
  if (!APPROVE_RE.test(rows[0].label) || !rows.some((row) => REJECT_RE.test(row.label))) return null

  let hinted = false
  for (let i = end + 1; i < lines.length && i - end <= 4; i++) {
    if (PERMISSION_FOOTER_RE.test(lines[i])) { hinted = true; break }
  }
  if (!hinted) return null

  // Single-select, and no free-text row: every option here is a choice to be TAPPED. Verified on live
  // panes for claude, codex, devin and grok \u2014 one digit selects and submits, exactly as `rowKeys` assumes.
  return {
    view: { kind: 'question', permission: true, question: permissionTitle(lines, start), rows, multi: false, typeRow: null, dialog: permissionDialog(lines, start, end) },
    index: start,
  }
}

/** Every line of the dialog, untruncated: from its opening rule (or, with no frame, up to 12 lines above
 *  the rows) to its last row — never reaching back past the end of an earlier dialog. */
function permissionDialog(lines: string[], start: number, end: number): string {
  const floor = earlierDialogEnd(lines, start, 25)
  const rule = frameTop(lines, start, floor)
  const top = rule >= 0 ? rule + 1 : Math.max(0, start - 12, floor + 1)
  return lines.slice(top, end + 1).map((line) => line.trimEnd()).filter((line) => !ANY_RULE_RE.test(line)).join('\n').trim()
}

export function parseQuestionPane(capture: string): PaneView {
  return locateQuestionPane(capture)?.view ?? null
}

/** `parseQuestionPane`, with the line its dialog was anchored on. */
export function locateQuestionPane(capture: string): FoundDialog | null {
  const lines = stripAnsi(capture).replace(/\u00a0/g, ' ').split('\n')
  // Each CLI words its own footer, and OpenCode rewords it PER SCREEN — `enter submit` on a single
  // question, `enter toggle` on a multi-select, `enter confirm` on a step of a multi-question. They all
  // mark the same thing: the bottom of a live dialog.
  // `enter to submit answer` is Codex's request_user_input dialog (plan mode; captured live in
  // __fixtures__/question-codex.txt). Without it that dialog was never a question at all here: the dial
  // showed nothing while the pane waited, and a question it DID show could never be closed, because
  // the watcher had no fingerprint to notice leaving.
  const footer = lines.findLastIndex((l) => QUESTION_FOOTER_RE.test(l))
  // The review screen paints no footer and puts its rows BELOW the prompt, so it needs its own anchor.
  // Whichever anchor is LOWER on screen is the live one (the other is scrollback from an earlier step).
  const review = lines.findLastIndex((l) => /Ready to submit your answers/i.test(l))
  // Command Code's review screen has neither Claude's "Ready to submit your answers" line nor a footer:
  // it is a "Submit"/"Cancel" pair under a summary that is itself numbered. Anchor on that PAIR — the two
  // rows adjacent, in that order — because the summary lines above are numbered too and reading them as
  // options is how the device answered everything and then sat there, never submitting.
  const submit = findSubmitPair(lines)
  // Command Code paints the SAME dialog with no footer at all — the pane simply ends at the last option.
  // Its tab bar is the only thing above the rows that is unmistakably part of the dialog, so it anchors
  // that dialog, read DOWNWARD. Nothing else on either CLI's screen looks like "● X | ◯ Y" followed by a
  // numbered list, which is what keeps ordinary numbered output from being read as a question.
  const tabBar = findTabBarDialog(lines)
  // A permission prompt is one more anchor, and every anchor is ranked the same way: whichever sits
  // lowest on screen is the live dialog, the others are scrollback. That ordering is what keeps the two
  // apart in both directions — codex and hermes draw an approval whose footer the question anchor also
  // matches, and there the footer is BELOW the rows, so the question path (which reads a better title off
  // the same block) still wins. And a footer-less dialog under an answered one is the live one: anchored
  // on the answered one's footer instead, Command Code's question was announced as the OLD question.
  const permission = parsePermissionPane(lines)
  if (permission && permission.index > Math.max(footer, review, submit?.index ?? -1, tabBar)) {
    return { view: permission.view, at: permission.index }
  }
  if (tabBar > Math.max(footer, review, submit?.index ?? -1)) {
    const view = parseDownward(lines, tabBar)
    return view && { view, at: tabBar }
  }
  if (review > footer && review > (submit?.index ?? -1)) {
    for (let i = review + 1; i < lines.length && i - review <= 10; i++) {
      const row = parseRow(lines[i])
      if (row && /^submit answers$/i.test(row.label)) return { view: { kind: 'review', submitRow: row.number }, at: review }
    }
    return null
  }
  if (submit && submit.index > footer) return { view: { kind: 'review', submitRow: submit.row }, at: submit.index }
  if (footer < 0) return null

  // Rows belonging to this dialog: the numbered rows just above the footer, back to the row numbered 1 —
  // and never from above an earlier dialog's end, which is where a dialog whose top is scrolled out of
  // the pane would otherwise borrow its first rows.
  const rows: QuestionRow[] = []
  let checkbox = false   // `[ ]` / `[✔]` on a row ⇒ this question is multi-select
  let start = -1
  const floor = earlierDialogEnd(lines, footer, 40)
  for (let i = footer - 1; i > floor && footer - i <= 40; i--) {
    const row = parseRow(lines[i])
    if (!row) continue
    rows.unshift(row)
    if (/^\s*[❯›>]?\s*\d+\.\s+\[/.test(lines[i])) checkbox = true
    if (row.number === '1') { start = i; break }
  }
  const enterSubmits = /enter to submit answer/i.test(lines[footer])
  if (rows.length && start < 0 && enterSubmits) {
    return { view: { kind: 'question', partial: true, enterSubmits, question: '', rows, multi: checkbox, typeRow: null }, at: footer }
  }
  if (start < 0 || rows.length === 0) return null

  // The question is the nearest real text line above the rows. The dialog paints it between its header
  // and its rows — `[tab bar | header chip] · blank · question · blank · rows` — so those, and a rule,
  // are the TOP of this frame. Stop there, never skip past: mid-repaint the question line can be blank
  // for one capture, and walking on would pick up the PREVIOUS question still sitting in scrollback and
  // pair a stale title with the live options. An empty result just means "look again next tick". The
  // end of an earlier dialog is a top too: its footer is not this dialog's question.
  let question = ''
  const top = earlierDialogEnd(lines, start, 12)
  for (let i = start - 1; i > top && start - i <= 12; i--) {
    const line = lines[i].trim()
    if (!line) continue
    if (/[←→]/.test(line) || /^[☐☒✔✓]/.test(line) || /^[─━-]{6,}$/.test(line)) break
    // Hermes's batch panel marks the active question with `▸`; that marker is chrome, not the question.
    question = line.replace(/^▸\s*/, '')
    break
  }

  const answerable = rows.filter((r) => !CHAT_ROW.test(r.label) && !TYPE_ROW.test(r.label))
  return {
    view: {
      kind: 'question',
      ...(enterSubmits ? { enterSubmits } : {}),
      question,
      rows: answerable,
      multi: checkbox,
      typeRow: rows.find((r) => TYPE_ROW.test(r.label)) ?? null,
      dialog: dialogAbove(lines, start, footer),
    },
    at: footer,
  }
}

/**
 * A footer-anchored dialog, whole: up to 12 lines above its rows — stopping at a rule, a tab bar, the
 * agent's own output (a `•`/`⏺` bullet) or the end of an earlier dialog — down to its last row. Codex puts
 * the command it asks about here (`$ …`, wrapped over as many lines as it takes), with its reason and
 * environment.
 */
function dialogAbove(lines: string[], start: number, footer: number): string {
  let top = start
  const floor = earlierDialogEnd(lines, start, 12)
  for (let i = start - 1; i > floor && start - i <= 12; i--) {
    const line = lines[i].trim()
    if (/^[•⏺●]/.test(line) || /[←→]/.test(line) || /^[─━═-]{6,}$/.test(line)) break
    top = i
  }
  return lines.slice(top, footer).map((line) => line.trimEnd()).join('\n').trim()
}

/**
 * A dialog that asks to RUN or CHANGE something (an approval), whichever parser read it: a framed
 * permission prompt, or a footer dialog whose first row approves, whose rows include a rejection, and
 * which names a command (`$ …`) or asks "would you like to run / make …". What the pair's floor treats as
 * a permission prompt (pair/classify.ts); nothing else reads it.
 */
export function isApprovalDialog(view: QuestionView): boolean {
  if (view.permission) return true
  if (!view.rows.length || !APPROVE_RE.test(view.rows[0].label) || !view.rows.some((row) => REJECT_RE.test(row.label))) return false
  const text = view.dialog ?? view.question
  return /(^|\n)\s*\$ /.test(text) || /would you like to (run|make|apply|execute|edit|write)/i.test(text)
}

/** Match an answer to a row. The device stores option labels in an 80-byte buffer, so a long label comes
 *  back truncated — prefix matches count, in both directions. */
/**
 * The keystrokes that commit one row.
 *
 * Every engine but Amp numbers its options, so the digit both selects and submits in one press. Amp
 * draws an unnumbered list navigated with the arrow keys, so its rows carry an index and are reached by
 * walking down to them.
 */
