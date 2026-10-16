import type { AgentEngine } from '../engines/types.js'
import type { PaneInspection } from '../engines/facets/screen.js'
import { inspectPane, stripAnsi } from '../engines/kit/pane.js'
import { parsePiFooterProfile } from '../engines/pi/runtimeProfile.js'
const PI_FOOTER_BUDGET = /\d+(?:\.\d+)?%\s*\/\s*\S+/
export function inspectRuntimePane(engine: AgentEngine, capture: string): PaneInspection { return engine === 'pi' ? inspectPiPane(capture) : inspectPane(engine, capture) }
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
  const picker = /Thinking Level|Select reasoning depth|Type to search|Enter to select|Only showing models from/i
  // An open picker REPLACES the composer box: the captured pi pane has neither rule nor footer
  // (engines/pi/runtimeProfile.spec.ts, `other-screens.golden.json`), so that shape is the
  // `rules.length < 2` return below. Once the box IS on screen it is the current interaction, and
  // picker text above it is scrollback from an earlier one — read there, it held a pane busy
  // forever over a composer nobody was typing in. The generic reader scopes DIALOG_UI the same way
  // (kit/pane.ts `currentPaneUi`).
  const dialog = rules.length < 2 ? picker.test(text) : picker.test(lines.slice(rules[rules.length - 2]).join('\n'))
  if (rules.length < 2) return { idle: false, plan: false, dialog, draft: false }
  const band = lines.slice(rules[rules.length - 2] + 1, rules[rules.length - 1]).join('').trim()
  const draft = band.length > 0
  return { idle: footer && !dialog && !draft, plan: false, dialog, draft }
}

