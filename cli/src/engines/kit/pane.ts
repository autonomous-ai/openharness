import type { AgentEngine } from '../types.js'
import type { PaneInspection, PaneTakeover } from '../facets/screen.js'

type Takeover = (capture: string, currentUi: string) => PaneTakeover | null
export function stripAnsi(value: string): string {
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
function promptMarker(engine: AgentEngine): RegExp {
  if (engine === 'cursor') return /→/u
  if (engine === 'devin') return /[❭›❯]/u
  if (engine === 'opencode') return /┃/u
  return /[›❯]/u
}

export function inspectPane(engine: AgentEngine, capture: string, takeover: Takeover = () => null, planPattern = /\bplan mode on\b/i): PaneInspection {
  if (engine === 'opencode') return inspectGutterBoxPane(capture, true)
  if (engine === 'copilot') return inspectGutterBoxPane(capture, false)
  if (engine === 'grok') return inspectGrokPane(capture)
  const rawLines = capture.split('\n')
  const marks = promptMarker(engine)
  const promptIndex = latestPromptLine(rawLines, marks)
  const prompt = promptIndex >= 0 ? rawLines[promptIndex] : ''
  const currentUi = currentPaneUi(rawLines, promptIndex)
  const dialog = DIALOG_UI.test(currentUi) || takeover(capture, currentUi) !== null
  const plan = planPattern.test(currentUi)
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

export function paneModal(engine: AgentEngine, capture: string, readTakeover: Takeover = () => null): PaneTakeover | 'permission' | 'menu' | null {
  const rawLines = capture.split('\n')
  const currentUi = currentPaneUi(rawLines, latestPromptLine(rawLines, promptMarker(engine)))
  const takeover = readTakeover(capture, currentUi)
  if (takeover) return takeover
  // Below the prompt line: that line is the composer, or the echo of the last message, and either can
  // hold anything a person typed.
  if (PERMISSION_UI.test(currentUi.slice(currentUi.indexOf('\n') + 1))) return 'permission'
  return DIALOG_UI.test(currentUi.replace(/Starting MCP servers?/gi, '')) ? 'menu' : null
}

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
