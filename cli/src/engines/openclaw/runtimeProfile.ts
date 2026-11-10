/**
 * What OpenClaw's TUI shows on screen (read off 2026.11.2, `__fixtures__/screen-*.txt`): the state the pane is in, and
 * the model, thinking level and tokens from its footer.
 *
 *   openclaw tui - ws://127.0.0.1:18789 - agent main - session plain
 *    connected | idle
 *    agent main | session plain | deepseek/deepseek-v4.1-flash high | deliver:off | tokens 19k/1.0m (2%)
 *
 * The footer wraps at the window's width, even inside the token cell, so it is read joined.
 */
import type { PaneInspection } from '../facets/screen.js'
import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import { stripAnsi } from '../kit/pane.js'
import { RUNTIME_EFFORTS } from '../kit/runtime.js'
import { OPENCLAW_HEADER_URL, OPENCLAW_LOOPBACK } from './contract.js'

export type OpenclawPaneState = 'ready' | 'busy' | 'no-gateway' | 'no-token' | 'remote'

export interface OpenclawFooter {
  model: string
  /** The thinking level the footer prints after the model; absent when the model has none. */
  effort: string | null
  /** `<used>/<window>` as drawn (`19k/1.0m`); null while the TUI prints `?`. */
  tokens: string | null
}

const FOOTER_START = /^\s*agent \S+ \| session \S+ \| /
const RULE = /^\s*─{8,}\s*$/
const FOOTER = /^agent \S+ \| session \S+ \| (\S+)(?: (\S+))? \| deliver:\S+ \| tokens (\S+)/
// The status line says what the TUI is doing: `connected | idle`, `gateway reconnected | idle`, `connected | aborted`,
// `⠏ running • 6s | connected`, `gateway disconnected: <error> | idle`.
const READY = /^(?:gateway )?(?:connected|reconnected) \| (?:idle|aborted|error)$/
const BUSY = /^\S{1,2} (?:running|streaming|connecting)\b/

function clean(capture: string): string[] {
  return stripAnsi(capture).split('\n').map((line) => line.replace(/\s+$/, ''))
}

function footerStart(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (FOOTER_START.test(lines[i])) return i
  return -1
}

/** The status line is the last non-blank line above the footer. */
function statusLine(lines: readonly string[], footer: number): string {
  for (let i = footer - 1; i >= 0; i--) if (lines[i].trim()) return lines[i].trim()
  return ''
}

export function openclawPaneState(capture: string): OpenclawPaneState | null {
  const lines = clean(capture)
  const text = lines.join('\n')
  // Before a TUI exists: `openclaw tui` exits with this under a banner, and nothing else on screen is OpenClaw's.
  if (/^Missing gateway auth token\./m.test(text)) return 'no-token'
  const url = OPENCLAW_HEADER_URL.exec(text)?.[1]
  // The title scrolls off a long conversation; the footer, drawn last, does not.
  if (url && !OPENCLAW_LOOPBACK.test(url)) return 'remote'
  const footer = footerStart(lines)
  if (footer < 0) return null
  const status = statusLine(lines, footer)
  if (/^gateway disconnected\b/.test(status)) return 'no-gateway'
  if (BUSY.test(status)) return 'busy'
  return READY.test(status) ? 'ready' : null
}

/**
 * Model, thinking level and tokens from the footer. Null rather than a half-read footer, and null while the model is
 * still `unknown` (no Gateway has answered).
 */
export function parseOpenclawFooter(capture: string): OpenclawFooter | null {
  const lines = clean(capture)
  const start = footerStart(lines)
  if (start < 0) return null
  let joined = lines[start].trim()
  for (let i = start + 1; i < lines.length && lines[i].trim() && !RULE.test(lines[i]); i++) joined += ` ${lines[i].trim()}`
  const match = FOOTER.exec(joined)
  if (!match || match[1] === 'unknown') return null
  const level = match[2]?.toLowerCase()
  const used = match[3].split('/')[0]
  return {
    model: match[1],
    effort: level && RUNTIME_EFFORTS.has(level) ? level : null,
    tokens: used === '?' || !match[3].includes('/') ? null : match[3],
  }
}

/** Idle is a ready TUI with nothing typed in the composer, the band between the two rules under the footer. */
export function inspectOpenclawPane(capture: string): PaneInspection {
  const lines = clean(capture)
  const footer = footerStart(lines)
  const rules = lines.flatMap((line, index) => (index > footer && RULE.test(line) ? [index] : []))
  const draft = footer >= 0 && rules.length >= 2 && lines.slice(rules[rules.length - 2] + 1, rules[rules.length - 1]).join('').trim().length > 0
  return { idle: openclawPaneState(capture) === 'ready' && !draft, plan: false, dialog: false, draft }
}

/**
 * The workspace OpenClaw's tools run in: the session header's `cwd`, shown on the agent as a label because the pane's
 * folder is not it. A session `/model` made before any message records `/`, the Gateway's own folder: no label.
 */
function workspaceOf(header: Record<string, unknown>): string | null {
  const cwd = header.type === 'session' && typeof header.cwd === 'string' ? header.cwd.trim() : ''
  return cwd && cwd !== '/' ? cwd : null
}

class ProfileReader {
  readonly engine = 'openclaw' as const
  private readonly workspaces = new Map<string, string>()
  private readonly tokenCounts = new Map<string, string>()

  pane(context: InlineRuntimeContext, text: string): void | false {
    const footer = parseOpenclawFooter(text)
    if (!footer) return false
    const { state } = context
    state.model = footer.model
    state.effort = footer.effort
    state.observedAt = Date.now()
    if (footer.tokens) this.tokenCounts.set(context.session.sessionId, footer.tokens)
    else this.tokenCounts.delete(context.session.sessionId)
  }

  /** The session header is the window's first record; any other record leaves the workspace as it was. */
  transcript(context: InlineRuntimeContext, record: Record<string, unknown>): void {
    const workspace = workspaceOf(record)
    if (workspace) this.workspaces.set(context.session.sessionId, workspace)
    else if (record.type === 'session') this.workspaces.delete(context.session.sessionId)
  }

  /** The agent's workspace path, for the frame's `workspace`; null until its header is read. */
  workspace(sessionId: string): string | null { return this.workspaces.get(sessionId) ?? null }

  /** `<used>/<window>` as the footer last drew it. The count lags a turn behind, so it is a display, not a meter. */
  tokens(sessionId: string): string | null { return this.tokenCounts.get(sessionId) ?? null }

  forget(sessionId: string): void {
    this.workspaces.delete(sessionId)
    this.tokenCounts.delete(sessionId)
  }
}

export function createRuntimeProfileReader(): InlineRuntimeReader & ProfileReader { return new ProfileReader() }
