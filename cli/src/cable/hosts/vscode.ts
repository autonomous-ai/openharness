/**
 * The VS Code extension's tab (docs/specs/2026-11-15-device-wave1-checks.md, F3): a Claude Code session the extension
 * started opens on its tab by the extension's `vscode://anthropic.claude-code/open?session=<id>` link, then VS Code comes
 * forward as after any pane. The link was read in the extension's code, not in any document, and may change with any
 * release: VS Code still comes forward after it. The link and `open` are macOS's, so elsewhere nothing runs. Every value
 * came from a hook, so each is checked against its form before it reaches the link.
 */
import type { HostAdapter, Pane, Place } from './adapter.js'
import { APP_BUNDLES } from './hostDetect.js'
import { openPath } from './open.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'

/** A Claude Code session's own id, which the extension's link names. */
const VSCODE_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function createVscodeAdapter(deps: Pick<OrcaDeps, 'run' | 'platform'> & {
  /** The raw `HARNESS_OPEN_BIN` (open.ts openPath). */
  bin?: string
}): HostAdapter {
  const mac = deps.platform === 'darwin'
  const openBin = openPath(deps.bin)

  return {
    id: 'vscode',
    tap: 'before',
    paneOf(place: Place): Pane | undefined {
      const { CLAUDE_CODE_ENTRYPOINT: entrypoint, __CFBundleIdentifier: bundle } = place.hints
      const session = place.sessionId
      // The link is VS Code's own extension's: Cursor runs the same extension, which says the same word, and an app known
      // by TERM_PROGRAM alone may be another fork. It names Claude Code's sessions alone: an engine Claude Code's tools ran
      // from the tab (`codex exec`) inherits the word and the bundle id, and a Codex thread id is a UUID too.
      if (place.engine !== 'claude' || entrypoint !== 'claude-vscode' || bundle !== APP_BUNDLES.vscode || !session
        || !VSCODE_SESSION.test(session)) return undefined
      return { adapter: 'vscode', id: session }
    },
    canFocus: () => mac,
    // Exits 0 once macOS has handed the link on: VS Code still comes forward after it, as after any pane.
    async focus(pane) {
      return mac && VSCODE_SESSION.test(pane.id)
        && (await deps.run(openBin, [`vscode://anthropic.claude-code/open?session=${pane.id}`], RUN_TIMEOUT_MS)).code === 0
    },
  }
}
