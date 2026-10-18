import type { AgentEngine } from '../engines/types.js'
import type { PaneInspection } from '../engines/facets/screen.js'
import { inspectPane, stripAnsi } from '../engines/kit/pane.js'
import { parsePiFooterProfile } from '../engines/pi/runtimeProfile.js'
import { parsePrimeThinkingSelection } from '../engines/prime/runtimeProfile.js'
const PI_FOOTER_BUDGET = /\d+(?:\.\d+)?%\s*\/\s*\S+/
export function inspectRuntimePane(engine: AgentEngine, capture: string): PaneInspection {
  return engine === 'pi' ? inspectPiPane(capture) : engine === 'prime' ? inspectPrimePane(capture) : inspectPane(engine, capture)
}
function inspectPiPane(capture: string): PaneInspection {
  const lines = stripAnsi(capture).split('\n').map((line) => line.replace(/\s+$/, ''))
  const text = lines.join('\n')
  // Whether the footer is DRAWN, which is not the same question as whether its profile can be READ —
  // and conflating the two is what has broken this check twice.
  //
  // `parsePiFooterProfile` is strict on purpose: it must return a model AND an effort or nothing, so a
  // half-drawn redraw is never mistaken for a profile change. Idleness needs far less — only that the
  // normal view is on screen rather than a picker — and borrowing the strict reader for it meant every
  // footer shape it could not fully parse read as "still busy".
  //
  // The shape it could not parse: a model with no thinking ladder draws no `• <level>` at all, so the
  // line ends at the model name. EVERY grid model is that shape, because the provider block written in
  // `gridLaunch.ts` declares `reasoning: false` — which left every Pi agent on a grid permanently
  // AGENT_BUSY, refusing model switches over an idle pane (measured, pi 0.82, footer
  // `↑5.4k ↓292 1.5%/200k (auto)   Auto`).
  //
  // So: the profile still counts when it parses, and the token-budget readout — `0.0%/500k`,
  // `1.5%/200k`, present in both shapes and drawn by no picker — carries the rest.
  const footer = parsePiFooterProfile(text) !== null || PI_FOOTER_BUDGET.test(text)
  const rules: number[] = []
  lines.forEach((line, index) => { if (/^\s*─{8,}\s*$/.test(line)) rules.push(index) })
  const dialog = /Thinking Level|Select reasoning depth|Type to search|Enter to select|Only showing models from/i
    .test(lines.join('\n'))
  if (rules.length < 2) return { idle: false, plan: false, dialog, draft: false }
  const band = lines.slice(rules[rules.length - 2] + 1, rules[rules.length - 1]).join('').trim()
  const draft = band.length > 0
  return { idle: footer && !dialog && !draft, plan: false, dialog, draft }
}


/** The end of Prime's footer: `claude-opus-5-5:high · 9.7k (1%)`, or a model with no level drawn. */
const PRIME_FOOTER_USAGE = /·\s+\S+\s+\(\d+(?:\.\d+)?%\)\s*$/
/** Its working line: a braille spinner, a verb and the elapsed time (`⠋ Executing · 4s · ↑ 73 tokens`). */
const PRIME_SPINNER = /^\s*[\u2801-\u28ff]\s+\S.*·\s*\d+(?:\.\d+)?[smh]\b/
/** The model selector (`/model`, or a `/model` with no exact match): its key hints replace the composer. */
const PRIME_SELECTOR = /Enter select · Esc close|No matching models/

/**
 * Prime Agent (Pi's fork) draws its composer as ` >` — not a glyph the generic reader knows — and keeps its
 * footer on screen while it works, so neither Pi's rule (footer drawn = idle) nor the generic one holds.
 * Measured on prime-agent 0.9.5 (`lib/__fixtures__/prime-*.txt`): working is the spinner line just above
 * the composer, which is drawn through waiting, thinking, writing and a tool run alike; a selector replaces
 * the composer and footer; the slash-command autocomplete (`› medium   Moderate reasoning`) only ever opens
 * over typed text, which is a draft already.
 */
function inspectPrimePane(capture: string): PaneInspection {
  const lines = stripAnsi(capture).split('\n').map((line) => line.replace(/\s+$/, ''))
  const footerAt = lines.findLastIndex((line) => PRIME_FOOTER_USAGE.test(line))
  const composerAt = lines.findLastIndex((line) => /^ >(?:\s|$)/.test(line))
  // Only what is drawn below the latest footer: a closed selector can linger in the history above it.
  const below = lines.slice(footerAt + 1).join('\n')
  const dialog = PRIME_SELECTOR.test(below) || parsePrimeThinkingSelection(below) !== null
  if (footerAt < 0 || composerAt < 0 || composerAt > footerAt) return { idle: false, plan: false, dialog, draft: false }
  const draft = lines[composerAt].slice(2).replace(/\u00a0/g, ' ').trim().length > 0
  const working = lines.slice(Math.max(0, composerAt - 8), composerAt).some((line) => PRIME_SPINNER.test(line))
  return { idle: !working && !dialog && !draft, plan: false, dialog, draft }
}
