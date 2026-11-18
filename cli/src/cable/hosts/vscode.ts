/**
 * The VS Code extension's tab (docs/plans/2026-11-17-dial-vscode-follow-design.md): a Claude Code session the extension
 * started opens on its tab by the extension's `vscode://anthropic.claude-code/open?session=<id>` link, sent to VS Code
 * alone by its bundle id (appLink.ts), on a tap and on a rest of the dial, a rest only while VS Code is in front. The link
 * was read in the extension's code, not in any document, and may change with any release. The link and `open` are
 * macOS's, so elsewhere nothing runs. Every value came from a hook, so each is checked against its form before it reaches
 * the link.
 */
import type { HostAdapter, Pane, Place } from './adapter.js'
import { createAppLink, type AppLinkDeps } from './appLink.js'
import { APP_BUNDLES } from './hostDetect.js'

/** A Claude Code session's own id, which the extension's link names. */
const VSCODE_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function createVscodeAdapter(
  deps: AppLinkDeps,
): HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>> {
  return {
    id: 'vscode',
    tap: 'instead',
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
    // No forward of its own: its pane exists only with its hook's VS Code bundle id, so a link that fails leaves the
    // opener's fallback to bring VS Code (open.ts).
    ...createAppLink(deps, {
      session: VSCODE_SESSION,
      url: (session) => `vscode://anthropic.claude-code/open?session=${session}`,
      bundle: APP_BUNDLES.vscode,
    }),
  }
}
