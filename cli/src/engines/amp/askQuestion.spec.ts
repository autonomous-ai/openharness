import { describe, expect, it } from 'vitest'
import { ampSelectionKeys, parseAmpQuestionPane } from './askQuestion.js'
import type { QuestionView } from '../../lib/askQuestion.js'

/**
 * Captured from a live pane (amp 0.0.1786064749) with `amp permissions add ask shell_command` in effect,
 * trimmed only in width. The scrollbar column (`█`), the wrapped `workdir` value and the unnumbered rows
 * are all exactly as Amp drew them.
 */
const PANE = `
                    ╭─ Approval Required ──────────────────────────────────────────────────────────╮
                    │                                                                              │
                    │ shell_command:                                                             █ │
                    │   {                                                                        █ │
                    │     "command": "echo probe123",                                            █ │
                    │     "workdir":                                                             █ │
                    │ "/private/tmp/claude-502/-Users-nqhieu84-go-src-github-com-autonomous-ai-au█ │
                    │ tonomous-code/4e2858a3/scratchpad/amp-probe"                               █ │
                    │   }                                                                        █ │
                    │                                                                            █ │
                    │                                                                              │
                    │ ‣ Allow Once                                                                 │
                    │   Reject with feedback                                                       │
                    │   Allow All for This Session                                                 │
                    │   Allow All for Every Session                                                │
                    │                                                                              │
                    ╰──────────── ↑/↓/j/k move · Enter select · Ctrl+E/Ctrl+Y scroll · Esc cancel ─╯
 ┃ run the shell command: echo probe123
`

describe('amp approval dialog', () => {
  it('reads all four options in the order Amp draws them', () => {
    const view = parseAmpQuestionPane(PANE) as QuestionView
    expect(view?.kind).toBe('question')
    expect(view.rows.map((r) => r.label)).toEqual([
      'Allow Once', 'Reject with feedback', 'Allow All for This Session', 'Allow All for Every Session',
    ])
    expect(view.multi).toBe(false)
  })

  /**
   * "Reject with feedback" opens a free-text editor, which the device cannot type into — the same shape as
   * muse's "None of the above", which IS dropped. It is kept here because it is the only way to say no:
   * dropping it would leave a device user with four ways to approve and none to refuse.
   */
  it('keeps the refusal option even though it opens an editor', () => {
    const view = parseAmpQuestionPane(PANE) as QuestionView
    expect(view.rows.map((r) => r.label)).toContain('Reject with feedback')
  })

  it('names what is being approved, with the argument that fits on one line', () => {
    const view = parseAmpQuestionPane(PANE) as QuestionView
    // The wrapped `workdir` is deliberately not reassembled — only a whole pair on one line is used.
    expect(view.question).toBe('Approve shell_command: echo probe123')
  })

  it('walks to a row instead of pressing a digit', () => {
    const view = parseAmpQuestionPane(PANE) as QuestionView
    // Amp's list has no numbers: the first row is already highlighted, the rest are N presses away.
    expect(ampSelectionKeys(view.rows[0])).toEqual(['Enter'])
    expect(ampSelectionKeys(view.rows[1])).toEqual(['Down', 'Enter'])
    expect(ampSelectionKeys(view.rows[3])).toEqual(['Down', 'Down', 'Down', 'Enter'])
  })

  it('ignores a pane with no dialog on it', () => {
    expect(parseAmpQuestionPane('just some output\n$ ')).toBeNull()
    // A box that explains its own keys but is NOT an approval must not be scraped into a question —
    // the title is what proves it, and this is why the footer alone is not enough.
    expect(parseAmpQuestionPane('╭─ Something Else ─╮\n│ ‣ Yes │\n│   No │\n╰─ Enter select ─╯')).toBeNull()
  })

  it('anchors on the LAST dialog, so an answered one in the scrollback is not re-read', () => {
    const twice = `${PANE}\n${PANE.replace('echo probe123', 'echo second')}`
    const view = parseAmpQuestionPane(twice) as QuestionView
    expect(view.question).toBe('Approve shell_command: echo second')
  })

  /**
   * The same pane as `capture-pane -e` hands it over: SGR attributes kept, which is how every OTHER
   * engine's dialog arrives — 23 of the 33 captures in `lib/__fixtures__` carry them, up to 505 sequences
   * in one. `PANE` itself is trimmed to plain text, so nothing above can see this.
   *
   * Without the ESC in the strip pattern the attributes go and a BARE ESC is left where each colour was,
   * so the anchored row pattern cannot see past it: the highlighted row is dropped from the list and the
   * `tool:` line no longer reads, leaving the generic `Approval required`. A device user is then offered
   * three answers to a four-way approval, none of them the highlighted one.
   */
  const STYLED = PANE
    .replace(/^(\s*)│/gm, '$1\u001b[38;5;244m│')
    .replace(/╭─+╮/g, '\u001b[1m╭─+╮\u001b[0m')
    .replace(/╰[^╯]*╯/g, (line) => `\u001b[38;5;244m${line}\u001b[0m`)
    .replace(/‣ /g, '\u001b[7m‣ \u001b[0m')
    .replace(/█/g, '\u001b[38;5;240m█\u001b[0m')
    .replace(/Allow Once/g, '\u001b[38;2;255;255;255mAllow Once\u001b[39m')

  it('reads every option off a pane that still carries its SGR attributes', () => {
    const view = parseAmpQuestionPane(STYLED) as QuestionView
    expect(view?.kind).toBe('question')
    expect(view.rows.map((r) => r.label)).toEqual([
      'Allow Once', 'Reject with feedback', 'Allow All for This Session', 'Allow All for Every Session',
    ])
  })

  it('names what is being approved on a styled pane too, not just the generic prompt', () => {
    // The `‣ Allow Once` row is styled separately from its border, which is what dropped it before.
    const view = parseAmpQuestionPane(STYLED) as QuestionView
    expect(view.question).toBe('Approve shell_command: echo probe123')
  })

  it('does not eat bracketed text that is not an escape sequence', () => {
    // A path or a glob in the approved command is content, not styling: `[0m` must survive it.
    const bracketed = PANE.replace('echo probe123', 'cat log[0m].txt')
    const view = parseAmpQuestionPane(bracketed) as QuestionView
    expect(view.question).toBe('Approve shell_command: cat log[0m].txt')
  })
})
