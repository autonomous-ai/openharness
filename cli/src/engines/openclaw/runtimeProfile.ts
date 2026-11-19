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
import type { ProfileEvidence } from '../facets/runtime.js'
import { RUNTIME_EFFORTS } from '../kit/runtime.js'
import { readOpenclawScreen } from './contract.js'

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

/**
 * An OpenClaw pane, from one reading of its screen. Idle is a ready TUI with nothing typed in its input box. A run on
 * screen, `⠦ running • 45s | connected`, is its activity: its status word as the label (`…` as `...`, as Claude Code's
 * and Codex's read) and the status line as the indicator. Starting up and connecting are not work.
 */
export function readOpenclawPane(capture: string): { pane: PaneInspection; activity: { label: string; indicator: string } | null } {
  const { state, status, box } = readOpenclawScreen(capture)
  const draft = !!box
  const label = state === 'busy' && status ? /^\S{1,2} (.+?) • /.exec(status)?.[1] : undefined
  return {
    pane: { idle: state === 'ready' && !draft, plan: false, dialog: false, draft },
    activity: label && status ? { label: label.replace(/…/g, '...'), indicator: status } : null,
  }
}

export function inspectOpenclawPane(capture: string): PaneInspection {
  return readOpenclawPane(capture).pane
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
  private readonly tokenCounts = new Map<string, string>()

  pane(context: InlineRuntimeContext, text: string): void | false {
    const footer = parseOpenclawFooter(text)
    if (!footer) return false
    const { state } = context
    state.model = footer.model
    // A model with no thinking level shows none, and a profile names one: `auto`, as OpenCode's reader says it.
    state.effort = footer.effort ?? 'auto'
    state.observedAt = Date.now()
    if (footer.tokens) this.tokenCounts.set(context.session.sessionId, footer.tokens)
    else this.tokenCounts.delete(context.session.sessionId)
  }

  /** `<used>/<window>` as the footer last drew it. The count lags a turn behind, so it is a display, not a meter. */
  tokens(sessionId: string): string | null { return this.tokenCounts.get(sessionId) ?? null }

  forget(sessionId: string): void {
    this.tokenCounts.delete(sessionId)
  }
}

export function createRuntimeProfileReader(): InlineRuntimeReader & ProfileReader { return new ProfileReader() }

/** The session header is the window's first record, read in the other engines' worker (engines/others/streams.ts): the
 *  workspace it names, or none; any other record leaves the workspace as it was. */
export function transcriptEvidence(record: Record<string, unknown>): ProfileEvidence | null {
  const workspace = workspaceOf(record)
  return workspace ? { workspace } : record.type === 'session' ? { workspace: null } : null
}
