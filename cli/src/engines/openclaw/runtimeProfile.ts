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
import { RUNTIME_EFFORTS } from '../kit/runtime.js'
import { OPENCLAW_RULE, openclawScreenLines, readOpenclawScreen } from './contract.js'

export interface OpenclawFooter {
  model: string
  /** The thinking level the footer prints after the model; absent when the model has none. */
  effort: string | null
  /** `<used>/<window>` as drawn (`19k/1.0m`); null while the TUI prints `?`. */
  tokens: string | null
}

const MODEL = /^agent \S+(?: \([^)]*\))? \| session \S+(?: \([^)]*\))? \| (\S+)(?: (\S+))? \| (?:.* \| )?deliver:\S+ \| tokens (\S+)/

/**
 * Model, thinking level and tokens from the footer. Null rather than a half-read footer, and null while the model is
 * still `unknown` (no Gateway has answered).
 */
export function parseOpenclawFooter(capture: string): OpenclawFooter | null {
  const footer = readOpenclawScreen(capture).footer
  const match = footer ? MODEL.exec(footer) : null
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
  const screen = readOpenclawScreen(capture)
  const lines = openclawScreenLines(capture)
  const rules = lines.flatMap((line, index) => (OPENCLAW_RULE.test(line) ? [index] : []))
  const draft = screen.footer !== null && lines.slice(rules[rules.length - 2] + 1, rules[rules.length - 1]).join('').trim().length > 0
  return { idle: screen.state === 'ready' && !draft, plan: false, dialog: false, draft }
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
