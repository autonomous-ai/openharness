/**
 * The Claude app (docs/specs/2026-11-15-device-host-adapter.md): its session opens by its `claude://code/continue`
 * link (appLink.ts), sent to the app alone by its bundle id, which brings the app forward itself. The session id came
 * from a hook, or from the session's own record for one only the open scan found
 * (docs/plans/2026-11-18-dial-claude-app-swipe-before-hook-design.md), so it is checked against its form before it
 * reaches the link.
 */
import type { HostAdapter, Pane, Place } from './adapter.js'
import { createAppLink, type AppLinkDeps } from './appLink.js'
import { APP_BUNDLES } from './hostDetect.js'

/** The check the Claude app makes of a session its `claude://code/continue` link names (read in the app, 2026-11-14). */
export const CLAUDE_SESSION = /^local_[A-Za-z0-9-]{1,64}$/

/** The key a session is known by on the Claude app's page: the store's source lists the same session by it, so a live
 *  agent's row and the store's row are one. */
export function claudePaneKey(localId: string): string {
  return `claude-app:${localId}`
}

export function createClaudeAppAdapter(
  deps: AppLinkDeps,
): HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show' | 'paneKey'>> {
  return {
    id: 'claude',
    tap: 'instead',
    bundle: APP_BUNDLES.claude,
    paneOf(place: Place): Pane | undefined {
      const { __CFBundleIdentifier: bundle, CLAUDE_CODE_HOST_SESSION_ID: session } = place.hints
      // The link is the Claude app's: a session id another app's agent carries opens no link.
      if (bundle === APP_BUNDLES.claude && session && CLAUDE_SESSION.test(session)) {
        return { adapter: 'claude', id: session }
      }
      // Before its first hook, both the scan's parents and the session's record must say the Claude app.
      const scanned = place.hostSession
      if (place.app !== 'claude' || !scanned || !CLAUDE_SESSION.test(scanned)) return undefined
      return { adapter: 'claude', id: scanned }
    },
    paneKey: (pane) => claudePaneKey(pane.id),
    // No forward of its own: a link that fails leaves the opener's fallback to bring the app, by the hook's bundle id
    // or, for a session only the open scan found, by this adapter's bundle (observed.ts target(), open.ts).
    ...createAppLink(deps, {
      session: CLAUDE_SESSION,
      url: (session) => `claude://code/continue?session=${session}`,
      bundle: APP_BUNDLES.claude,
    }),
  }
}
