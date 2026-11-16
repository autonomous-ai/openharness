/**
 * The Claude app (docs/specs/2026-11-15-device-host-adapter.md): its session opens by its `claude://code/continue`
 * link (appLink.ts), sent to the app by its bundle id so no other app registered for `claude://` takes it; the link
 * brings the app forward itself. The session id came from a hook, so it is checked against its form before it reaches
 * the link.
 */
import type { HostAdapter, Pane, Place } from './adapter.js'
import { createAppLink, type AppLinkDeps } from './appLink.js'
import { APP_BUNDLES } from './hostDetect.js'

/** The check the Claude app makes of a session its `claude://code/continue` link names (read in the app, 2026-11-14). */
const CLAUDE_SESSION = /^local_[A-Za-z0-9-]{1,64}$/

export function createClaudeAppAdapter(
  deps: AppLinkDeps,
): HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>> {
  return {
    id: 'claude',
    tap: 'instead',
    paneOf(place: Place): Pane | undefined {
      const { __CFBundleIdentifier: bundle, CLAUDE_CODE_HOST_SESSION_ID: session } = place.hints
      // The link is the Claude app's: a session id another app's agent carries opens no link.
      if (bundle !== APP_BUNDLES.claude || !session || !CLAUDE_SESSION.test(session)) return undefined
      return { adapter: 'claude', id: session }
    },
    // The link goes to the app by its bundle id: another app that registers `claude://` never gets it. No forward of its
    // own: its pane exists only with its hook's bundle id, so a link that fails leaves the opener's fallback to bring the
    // app (open.ts).
    ...createAppLink(deps, {
      session: CLAUDE_SESSION,
      url: (session) => `claude://code/continue?session=${session}`,
      bundle: APP_BUNDLES.claude,
    }),
  }
}
