/**
 * The Claude app (docs/specs/2026-11-15-device-host-adapter.md): its session opens by its `claude://code/continue`
 * link, which brings the app forward itself. The link and `open` are macOS's, so elsewhere nothing runs. The session id
 * came from a hook, so it is checked against its form before it reaches the link.
 */
import type { HostAdapter, Pane, Place } from './adapter.js'
import { APP_BUNDLES } from './hostDetect.js'
import { OPEN } from './open.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'
import type { PaneSwitch } from './types.js'

/** The check the Claude app makes of a session its `claude://code/continue` link names (read in the app, 2026-11-14). */
const CLAUDE_SESSION = /^local_[A-Za-z0-9-]{1,64}$/

export function createClaudeAppAdapter(
  deps: Pick<OrcaDeps, 'run' | 'platform'> & { inFront(): boolean },
): HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>> {
  const mac = deps.platform === 'darwin'
  // A rest's link at a time per agent, in a set of its own: a tap is not refused while a rest's link runs, nor a rest
  // while a tap runs, and two opens of one link do no harm.
  const showing = new Set<string>()

  const link = async (session: string): Promise<boolean> =>
    (await deps.run(OPEN, [`claude://code/continue?session=${session}`], RUN_TIMEOUT_MS)).code === 0

  return {
    id: 'claude',
    tap: 'instead',
    paneOf(place: Place): Pane | undefined {
      const { __CFBundleIdentifier: bundle, CLAUDE_CODE_HOST_SESSION_ID: session } = place.hints
      // The link is the Claude app's: a session id another app's agent carries opens no link.
      if (bundle !== APP_BUNDLES.claude || !session || !CLAUDE_SESSION.test(session)) return undefined
      return { adapter: 'claude', id: session }
    },
    canFocus: () => mac,
    async focus(pane) {
      return mac && CLAUDE_SESSION.test(pane.id) && link(pane.id)
    },
    // Asked at each look: the app may have left the front since the last one.
    canShow: () => mac && deps.inFront(),
    // A rest of the dial shows the session in the app, which is already in front: a link that fails brings no app
    // forward, and its outcome is the swipe's own count.
    async show(pane, agentId): Promise<PaneSwitch> {
      if (!mac || !CLAUDE_SESSION.test(pane.id)) return 'failed'
      if (showing.has(agentId)) return 'busy'
      showing.add(agentId)
      try {
        return (await link(pane.id)) ? 'ok' : 'failed'
      } finally {
        showing.delete(agentId)
      }
    },
  }
}
