import type { AgentEngine } from '../engines/types.js'
import type { FoundDialog, PaneView, QuestionView } from '../engines/facets/screen.js'
import { locateQuestionPane, parseQuestionPane, parseRow, stripAnsi } from '../engines/kit/questionPane.js'
import { earlierDialogEnd } from './dialogEnd.js'
import { locateMuseQuestion } from '../engines/muse/askQuestion.js'
import { parseAmpQuestionPane } from '../engines/amp/askQuestion.js'
import { locateKiloQuestion, parseKiloQuestionPane } from '../engines/kilo/askQuestion.js'
import { parseCursorPermissionPane } from '../engines/cursor/askQuestion.js'
import { locateDevinPermission, locateDevinQuestion } from '../engines/devin/askQuestion.js'
import { parseGrokQuestionPane } from '../engines/grok/askQuestion.js'
import { locateAgyQuestion } from '../engines/agy/askQuestion.js'
import { withCopilotSubject } from '../engines/copilot/askQuestion.js'
function permissionView(view: PaneView): PaneView {
  return view?.kind === 'question' ? { ...view, permission: true } : view
}

function asPermission(found: FoundDialog | null): FoundDialog | null {
  return found && { ...found, view: permissionView(found.view) as QuestionView }
}

/**
 * The LOWEST dialog any reader found: the live one. A pane keeps an answered dialog in its scrollback, and
 * an engine with two readers (a question and an approval, say) must never let the first reader's hit on
 * that one shadow the second reader's hit on the dialog under it: devin's approval under its answered
 * question, muse's approval under a question, opencode's question under an approval. A tie is one dialog
 * read twice, and the earlier reader, the engine's own, keeps it.
 */
function lowest(...found: Array<FoundDialog | null>): PaneView {
  let best: FoundDialog | null = null
  for (const f of found) if (f && (!best || f.at > best.at)) best = f
  return best?.view ?? null
}

/**
 * The dialog on screen, read the way `engine` paints it: the LAST one on the pane, and nothing of it from
 * above an earlier dialog's end (`dialogEnd.ts`).
 *
 * Claude and Command Code share one shape (see parseQuestionPane); devin draws a different one and gets
 * its own parser rather than more branches in here.
 */
export function parseEngineQuestionPane(engine: AgentEngine, capture: string): PaneView {
  if (engine === 'claude' || engine === 'codex') throw new Error('Native screen reader must be injected')
  // Devin's two dialogs are told apart by one word in the footer (`↵ select` vs `↵ confirm`), so they can
  // never both match the same dialog; but an answered one of either kind can sit above the live one.
  if (engine === 'devin') return lowest(locateDevinQuestion(capture), asPermission(locateDevinPermission(capture)))
  // Cursor has no ask-the-user tool, so its permission prompt is the ONLY dialog it ever draws — and it
  // numbers nothing, stating each row's key in the row instead.
  if (engine === 'cursor') return permissionView(parseCursorPermissionPane(capture))
  // Muse pairs each option with a description on the same line and floats a live Preview box above the
  // rows — both confuse the shared parser, so it reads its own. Its PERMISSION prompt is a different
  // dialog entirely (`Would you like to allow this network access?` over `1. Yes, proceed (y)` rows under
  // a `Press enter to confirm` footer, `__fixtures__/permission-muse.txt`) and that one the shared parser
  // reads exactly, so it is read by both and the lower wins.
  if (engine === 'muse') return lowest(locateMuseQuestion(capture), locateQuestionPane(capture))
  // Amp's is a permission prompt with unnumbered rows — nothing the shared parser can anchor on.
  if (engine === 'amp') return permissionView(parseAmpQuestionPane(capture))
  // Kilo's is the same kind of prompt but laid out HORIZONTALLY, sharing its line with the key hints —
  // it is a fork of opencode that did not keep opencode's dialog.
  if (engine === 'kilo') return permissionView(parseKiloQuestionPane(capture))
  // Grok tells its approval from its questionnaire itself, by the live dialog's own footer.
  if (engine === 'grok') return parseGrokQuestionPane(capture)
  // agy's ask-the-user dialog anchors on `Question N/M:` under an `↑/↓ Navigate` footer, which the
  // shared parser cannot see. Its PERMISSION prompt is numbered rows under `Do you want to proceed?`
  // and the shared parser reads that one exactly, so it is read by both and the lower wins.
  if (engine === 'agy') return lowest(locateAgyQuestion(capture), locateQuestionPane(capture))
  // Hermes, OpenCode and Copilot paint the dialog inside a box; peel the border and the shared parser
  // fits. Measured on Copilot: framed it returns null, unframed it reads the question, the three
  // options AND spots `4. Other (type your answer)` as the free-text row rather than an option.
  if (engine === 'hermes') return parseQuestionPane(unframe(capture))
  // Copilot boxes its dialog the same way, but names the SUBJECT of a permission prompt above the
  // question — "attempting to access the following URL:" over a boxed value. Without it the device
  // shows "Do you want to allow this access?" and a bare "Yes", with nothing to judge.
  if (engine === 'copilot') {
    const found = locateQuestionPane(unframe(capture))
    return found ? withCopilotSubject(found.view, capture, found.at) : null
  }
  if (engine === 'opencode') {
    // OpenCode's PERMISSION prompt is the horizontal one kilo inherited from it — same `△ Permission
    // required` title, same `⇆ select · enter confirm` footer, same unnumbered rows. Measured: the live
    // capture in `permission-opencode.txt` parses through kilo's parser unchanged, so it is shared rather
    // than copied. Listed FIRST because that dialog numbers nothing: on its own dialog the shared parser
    // still matches the `enter confirm` footer and walks up into whatever numbered rows are above, and
    // the tie goes to kilo's reader.
    const plain = unframe(capture)
    return lowest(asPermission(locateKiloQuestion(capture)), locateOpencodeReview(plain), locateQuestionPane(plain))
  }
  return parseQuestionPane(capture)
}

function locateOpencodeReview(plain: string): FoundDialog | null {
  const lines = stripAnsi(plain).split('\n')
  const footer = lines.findLastIndex((l) => /enter\s+submit/i.test(l))
  if (footer < 0) return null
  const floor = earlierDialogEnd(lines, footer, 14)
  let sawReview = false
  for (let i = footer - 1; i > floor && footer - i <= 14; i--) {
    if (parseRow(lines[i])) return null            // rows above ⇒ still a question, not the review
    if (/^\s*review\s*$/i.test(lines[i])) { sawReview = true; break }
  }
  return sawReview ? { view: { kind: 'review', submitRow: 'Enter' }, at: footer } : null
}

function unframe(capture: string): string {
  // stripAnsi FIRST: on a real capture the border is preceded by SGR codes, so matching `^│` against the
  // raw text silently never fired — hermes read as "no dialog open" with the dialog plainly on screen.
  return stripAnsi(capture)
    .split('\n')
    .map((line) => {
      const left = line.replace(/^(\s*)[│┃|]\s?/, '$1')
      // An unanchored whitespace regex retries at every column on blank rows.
      // Inspect the last non-space character once; keep unframed lines intact.
      const right = left.trimEnd()
      return /[│┃|]$/.test(right) ? right.slice(0, -1).trimEnd() : left
    })
    .join('\n')
}

/** How this engine's multi-select dialog is submitted once the boxes are ticked. */
