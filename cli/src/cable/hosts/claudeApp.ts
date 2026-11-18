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
import { openPath } from './open.js'
import { RUN_TIMEOUT_MS } from './orca.js'

/** The check the Claude app makes of a session its `claude://code/continue` link names (read in the app, 2026-11-14). */
const CLAUDE_SESSION = /^local_[A-Za-z0-9-]{1,64}$/

export function createClaudeAppAdapter(
  deps: AppLinkDeps & { log(line: string): void },
): HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>> {
  const openBin = openPath(deps.bin)
  return {
    id: 'claude',
    tap: 'instead',
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
    ...createAppLink(deps, {
      session: CLAUDE_SESSION,
      url: (session) => `claude://code/continue?session=${session}`,
      bundle: APP_BUNDLES.claude,
      // A session only the open scan found has no bundle until its first hook (observed.ts), so the opener alone could
      // not bring the app when its link failed (open.ts).
      async forward() {
        // The line the opener writes for every pane's fallback: which app only, never the session.
        deps.log('[device] open · claude · fallback')
        return (await deps.run(openBin, ['-b', APP_BUNDLES.claude], RUN_TIMEOUT_MS)).code === 0
      },
    }),
  }
}
