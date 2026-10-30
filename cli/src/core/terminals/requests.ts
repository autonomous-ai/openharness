/**
 * Requests about a harness's terminal itself, rather than the agent in it: what its pane runs and where
 * (`terminal_info`), and the colours the desktop paints panes with (`theme_set`).
 *
 * Moved verbatim out of the socket's request switch (docs/design/2026-10-03-harnessd.md).
 */
import { parseHostTheme, type HostTheme } from '../../lib/hostTheme.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { primaryRuntime } from '../../lib/terminalRuntime.js'
import type { TerminalPaneInfo, TerminalRuntimeRef } from '../../lib/terminalTypes.js'

export interface TerminalRequestDeps {
  resolve: (id: string) => RegisteredSession | undefined
  /** The pane's own backend's word on it (`TerminalBackend.paneInfo`), asked with the row's runtime: never the
   *  bare `tmuxPane`, which is a ptyhost pane's id on a ptyhost row. */
  paneInfo: (runtime: TerminalRuntimeRef) => Promise<TerminalPaneInfo | null>
  /** Makes a pair of colours this machine's tmux `window-style` (cli.ts). */
  applyTheme: (theme: HostTheme) => void
}

export function createTerminalRequests({ resolve, paneInfo, applyTheme }: TerminalRequestDeps) {
  /** Answers `terminal_info` through `reply`, once tmux has answered: never in the connection's line. */
  const terminalInfo = (payload: Record<string, unknown>, reply: (result: Record<string, unknown>) => void): void => {
    // What a harness's pane runs now and where — tmux's #{pane_current_command} and
    // #{pane_current_path}, for a terminal client's formats. Read-only. Not in the e2ee
    // sets (core.ts is hash-pinned with the other implementations), so it answers the local
    // client; over the relay a peer is not asked, and the client keeps its fallback.
    const id = payload.agentId
    const agent = typeof id === 'string' ? resolve(id) : undefined
    if (!agent?.runtimes.length) { reply({ error: 'AGENT_NOT_FOUND' }); return }
    void paneInfo(primaryRuntime(agent)).then(info => reply(info ? { ...info } : { error: 'PANE_NOT_FOUND' }))
  }

  /**
   * The reply to `theme_set`: the colours the desktop paints its panes with, so tmux answers a TUI's
   * OSC 10/11 with them instead of with whatever terminal happened to attach first (lib/hostTheme.ts).
   * A malformed pair is refused, never half-applied.
   */
  const themeSet = (payload: Record<string, unknown>): Record<string, unknown> => {
    const theme = parseHostTheme(payload)
    if (!theme) return { error: 'BAD_THEME' }
    applyTheme(theme)
    return { applied: true }
  }

  return { terminalInfo, themeSet }
}
